import { create } from "@bufbuild/protobuf";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ObjectSerializer } from "@datadog/datadog-api-client/dist/packages/datadog-api-client-v1/models/ObjectSerializer.js";
import { MetricsQueryResponse } from "@datadog/datadog-api-client/dist/packages/datadog-api-client-v1/models/MetricsQueryResponse.js";
import { getAuthData } from "../../token";
import {
  ExecuteCellsRequestSchema,
  KernelsService,
} from "../../protogen/oaiproto/aisre/kernels_pb.js";
import { parser_pb } from "../../runme/client";
import * as d3 from "d3";

// This file contains functions that we want to be available to code
// running inside js cells

type KernelsClient = Client<typeof KernelsService>;

let kernelsClient: KernelsClient | null = null;
let configuredBaseUrl: string | undefined;

function configureDatadogRuntime(options: { baseUrl: string }) {
  configuredBaseUrl = normalizeBaseUrl(options.baseUrl);
  kernelsClient = null;
}

function normalizeBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return defaultBaseUrl();
  }
  return trimmed.replace(/\/+$/, "");
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "/";
}

function getKernelsClient(): KernelsClient {
  if (!kernelsClient) {
    const transport = createConnectTransport({
      baseUrl: getCurrentBaseUrl(),
      useBinaryFormat: false,
    });
    kernelsClient = createClient(KernelsService, transport);
  }
  return kernelsClient;
}

function getCurrentBaseUrl(): string {
  const normalized = configuredBaseUrl ?? normalizeBaseUrl();
  return normalized === "" ? "/" : normalized;
}

function buildAuthHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function help() {
  console.log("Datadog module functions:");
  console.log(
    " - query(query: string, from: string, to: string): Promise<any>",
  );
  console.log(" - plotMetrics(data: any, runme: any): void");
  console.log("");
  console.log("Example usage:");
  console.log(
    ' const data = await datadog.query("avg:system.cpu.user{*} by {host}", "now-1h", "now");',
  );
  console.log(" datadog.plotMetrics(data, runme);");
}

async function query(
  q: string,
  from: string,
  to: string,
): Promise<MetricsQueryResponse> {
  console.log("Running Datadog query:", q, "from:", from, "to:", to);
  const datadogCell = create(parser_pb.CellSchema, {
    kind: parser_pb.CellKind.CODE,
    languageId: "datadog.com/metrics",
    value: `
from: "${from}"
to: "${to}"
queries:
  - "${q}"`,
  });

  const payload = create(ExecuteCellsRequestSchema, {
    cells: [datadogCell],
  });

  console.log("Datadog getAuthTokens");
  const authData = await getAuthData();
  const token = authData?.idToken;

  if (token == null || token === "") {
    console.error("Datadog query aborted: missing runme token.");
    return {} as MetricsQueryResponse;
  }

  const client = getKernelsClient();
  const result = await client.executeCells(payload, {
    headers: buildAuthHeaders(token),
  });

  // Find first output item with mime type application/json
  const ddOutput = result?.cells?.[0]?.outputs?.[0]?.items?.find(
    (item) => item.mime === "application/json",
  );

  if (!ddOutput) {
    console.warn("No application/json output found.");
    return {} as MetricsQueryResponse;
  }

  try {
    const text = toJSONString(ddOutput.data);
    const parsed = JSON.parse(text);
    const typed = ObjectSerializer.deserialize(
      parsed,
      "MetricsQueryResponse",
    ) as MetricsQueryResponse;
    return typed;
  } catch (err) {
    console.error("Failed to parse Datadog JSON output", err);
    return {} as MetricsQueryResponse;
  }
}

function toJSONString(data: string | Uint8Array): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(data);
    }
    // Fallback for environments without TextDecoder
    let result = "";
    for (let i = 0; i < data.length; i++) {
      result += String.fromCharCode(data[i]);
    }
    return result;
  }
  return String(data ?? "");
}

function plotMetrics(
  data: MetricsQueryResponse,
  runme: any,
  options?: { title?: string; xLabel?: string; yLabel?: string },
) {
  console.log("Plotting Datadog data...");
  // Expecting Datadog JSON as shown in the example (data.series[0].pointlist = [[tsMs, value], ...])
  if (!data || !Array.isArray(data.series) || data.series.length === 0) {
    console.warn("No series to plot.");
    return;
  }

  // Support multiple series; gather all points to compute global scales
  const seriesList = (data.series ?? [])
    .map((s, i) => {
      const pts = (s.pointlist || [])
        .filter(
          (p) =>
            Array.isArray(p) && p.length >= 2 && p[0] != null && p[1] != null,
        )
        .map(([x, y]) => ({ x: new Date(Number(x)), y: Number(y) }));
      return {
        id: i,
        name: s.display_name || `series_${i}`,
        scope: s.scope || "",
        interval: s.interval,
        points: pts,
      };
    })
    .filter((s) => s.points.length > 0);

  if (seriesList.length === 0) {
    console.warn("All series are empty; nothing to plot.");
    return;
  }

  const allPoints = seriesList.flatMap((s) => s.points);
  const xDomain = d3.extent(allPoints, (d) => d.x);
  const yMax =
    d3.max(allPoints, (d) => (Number.isFinite(d.y) ? d.y : null)) ?? 0;

  // Clear and render using runme notebook helpers
  runme.clear();
  runme.render((selection) => {
    const width = 820;
    const height = 360;
    const margins = { top: 40, right: 24, bottom: 50, left: 64 };
    const innerWidth = width - margins.left - margins.right;
    const innerHeight = height - margins.top - margins.bottom;
    const svg = selection
      .append("svg")
      .attr("width", width)
      .attr("height", height);

    const plot = svg
      .append("g")
      .attr("transform", `translate(${margins.left},${margins.top})`);

    const x = d3.scaleTime().domain(xDomain).range([0, innerWidth]);
    const y = d3
      .scaleLinear()
      .domain([0, yMax === 0 ? 1 : yMax])
      .nice()
      .range([innerHeight, 0]);

    const xAxis = d3.axisBottom(x).ticks(6);
    const yAxis = d3.axisLeft(y).ticks(6);

    plot
      .append("g")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(xAxis)
      .call((g) =>
        g
          .append("text")
          .attr("x", innerWidth / 2)
          .attr("y", margins.bottom - 12)
          .attr("fill", "#333")
          .attr("text-anchor", "middle")
          .attr("font-size", 12)
          .text(options?.xLabel ?? "Time"),
      );

    plot
      .append("g")
      .call(yAxis)
      .call((g) =>
        g
          .append("text")
          .attr("transform", "rotate(-90)")
          .attr("x", -innerHeight / 2)
          .attr("y", -margins.left + 14)
          .attr("fill", "#333")
          .attr("text-anchor", "middle")
          .attr("font-size", 12)
          .text(options?.yLabel ?? "Value"),
      );

    const line = d3
      .line()
      .defined((d) => Number.isFinite(d.y))
      .x((d) => x(d.x))
      .y((d) => y(d.y));

    // Optional: ordinal color for multiple series (falls back to default stroke if not available)
    const color = d3
      .scaleOrdinal(d3.schemeCategory10)
      .domain(seriesList.map((s) => s.id));

    const seriesGroup = plot
      .selectAll(".series")
      .data(seriesList)
      .join("g")
      .attr("class", "series");

    seriesGroup
      .append("path")
      .attr("fill", "none")
      .attr("stroke-width", 1.75)
      .attr("stroke", (s) => (color ? color(s.id) : null))
      .attr("d", (s) => line(s.points));

    // Title
    const title =
      options?.title ||
      data.query ||
      seriesList[0]?.name ||
      "Datadog Time Series";
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", margins.top / 2)
      .attr("text-anchor", "middle")
      .attr("font-size", 16)
      .attr("font-weight", 600)
      .text(title);

    // Basic legend for multiple series
    if (seriesList.length > 1) {
      const legend = svg
        .append("g")
        .attr("transform", `translate(${margins.left}, ${height - 12})`);

      legend
        .selectAll("g")
        .data(seriesList)
        .join("g")
        .attr("transform", (_, i) => `translate(${i * 180}, 0)`)
        .call((g) =>
          g
            .append("line")
            .attr("x1", 0)
            .attr("x2", 18)
            .attr("y1", -4)
            .attr("y2", -4)
            .attr("stroke-width", 2)
            .attr("stroke", (s) => (color ? color(s.id) : null)),
        )
        .call((g) =>
          g
            .append("text")
            .attr("x", 24)
            .attr("y", 0)
            .attr("dominant-baseline", "middle")
            .attr("font-size", 12)
            .text((s) => s.name),
        );
    }
  });
}

export { help, query, plotMetrics, configureDatadogRuntime };
