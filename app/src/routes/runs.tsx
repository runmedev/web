import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Spinner,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";

import { RunmeContentWrapper } from "../layout";
import { useRuns, DEFAULT_RUNS_PAGE_SIZE } from "../lib/useRuns.js";

export default function RunsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const queryParam = searchParams.get("query") ?? "";
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const [searchValue, setSearchValue] = useState(queryParam);

  useEffect(() => {
    setSearchValue(queryParam);
  }, [queryParam]);

  const { data, isPending, isError, error, isFetching, refetch } = useRuns({
    page,
    pageSize: DEFAULT_RUNS_PAGE_SIZE,
    query: queryParam,
  });
  const showInitialLoading = isPending || (!data && isFetching);

  const totalPages = useMemo(() => {
    if (!data) {
      return 1;
    }
    return Math.max(1, Math.ceil(data.totalRuns / data.pageSize));
  }, [data]);

  useEffect(() => {
    if (!data) {
      return;
    }

    if (data.totalRuns === 0 && page !== 1) {
      const next = new URLSearchParams(searchParams);
      next.delete("page");
      setSearchParams(next);
      return;
    }

    const nextTotalPages = Math.max(
      1,
      Math.ceil(data.totalRuns / data.pageSize),
    );
    if (page > nextTotalPages) {
      const next = new URLSearchParams(searchParams);
      next.set("page", String(nextTotalPages));
      setSearchParams(next);
    }
  }, [data, page, searchParams, setSearchParams]);

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = searchValue.trim();
    const next = new URLSearchParams(searchParams);
    if (trimmed === "") {
      next.delete("query");
    } else {
      next.set("query", trimmed);
    }
    next.set("page", "1");
    setSearchParams(next);
  };

  const handleClearSearch = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("query");
    next.delete("page");
    setSearchParams(next);
  };

  const handlePageChange = (nextPage: number) => {
    const clamped = Math.max(1, nextPage);
    const next = new URLSearchParams(searchParams);
    next.set("page", String(clamped));
    setSearchParams(next);
  };

  const searchPlaceholder = "Search by run name prefix";

  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  const renderContent = () => {
    if (showInitialLoading) {
      return (
        <Flex
          align="center"
          direction="column"
          gap="3"
          justify="center"
          className="min-h-[240px]"
        >
          <Spinner />
          <Text color="gray">Loading runs…</Text>
        </Flex>
      );
    }

    if (isError) {
      return (
        <Callout.Root color="red">
          <Callout.Text weight="medium">Unable to load runs</Callout.Text>
          <Callout.Text>{error?.message ?? "Unknown error"}</Callout.Text>
        </Callout.Root>
      );
    }

    if (!data) {
      return null;
    }

    if (data.totalRuns === 0) {
      return (
        <Callout.Root color="yellow">
          <Callout.Text weight="medium">No runs found</Callout.Text>
          <Callout.Text>
            {queryParam
              ? "Try a different prefix."
              : "Create a run to see it listed here."}
          </Callout.Text>
        </Callout.Root>
      );
    }

    return (
      <Table.Root
        variant="surface"
        className="overflow-hidden rounded-md border border-gray-200"
      >
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Last Updated</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {data.runs.map((run) => {
            return (
              <Table.Row key={run.name}>
                <Table.Cell>
                  <Link
                    to={`/runs/${encodeURIComponent(run.name)}`}
                    className="text-blue-600 underline"
                  >
                    {run.name}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  {run.lastUpdated
                    ? formatter.format(new Date(run.lastUpdated))
                    : "—"}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    );
  };

  return (
    <RunmeContentWrapper>
      <Flex className="flex-col gap-4 p-4">
        <Flex align="center" justify="between">
          <Heading size="6" weight="bold">
            Runs
          </Heading>
          <Button
            onClick={() => void refetch()}
            variant="soft"
            disabled={isFetching}
          >
            Refresh
          </Button>
        </Flex>

        <form onSubmit={handleSearchSubmit}>
          <Flex align="center" gap="3">
            <TextField.Root
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-52"
            />
            <Button
              type="submit"
              variant="surface"
              disabled={isFetching && queryParam === searchValue.trim()}
            >
              Search
            </Button>
            {queryParam ? (
              <Button type="button" variant="ghost" onClick={handleClearSearch}>
                Clear
              </Button>
            ) : null}
          </Flex>
        </form>

        <Box className="relative min-h-[240px] rounded-md border border-gray-200 bg-white p-4 shadow-xs">
          {renderContent()}
          {data && !showInitialLoading && isFetching ? (
            <Flex
              align="center"
              className="absolute inset-0 z-10 rounded-md bg-white/70"
              direction="column"
              gap="3"
              justify="center"
            >
              <Spinner />
              <Text color="gray">Refreshing…</Text>
            </Flex>
          ) : null}
        </Box>

        {data ? (
          <Flex align="center" justify="between">
            <Text color="gray" size="2">
              Showing {data.runs.length} of {data.totalRuns} runs
            </Text>
            <Flex align="center" gap="3">
              <Button
                variant="surface"
                disabled={page <= 1 || isFetching}
                onClick={() => handlePageChange(page - 1)}
              >
                Previous
              </Button>
              <Text color="gray" size="2">
                Page {Math.min(page, totalPages)} of {totalPages}
              </Text>
              <Button
                variant="surface"
                disabled={
                  page >= totalPages ||
                  isFetching ||
                  (data.totalRuns === 0 && page === 1)
                }
                onClick={() => handlePageChange(page + 1)}
              >
                Next
              </Button>
            </Flex>
          </Flex>
        ) : null}
      </Flex>
    </RunmeContentWrapper>
  );
}
