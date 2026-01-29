import { create } from "@bufbuild/protobuf";
import {
  ExecuteRequestSchema,
  SessionStrategy,
  WinsizeSchema,
} from "@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb";
import {
  CommandMode,
  ProgramConfig_CommandListSchema,
} from "@buf/stateful_runme.bufbuild_es/runme/runner/v2/config_pb";

const SHELLISH = new Set([
  "sh",
  "shell",
  "bash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "dash",
  "powershell",
  "pwsh",
  "cmd",
  "ash",
  "elvish",
  "xonsh",
]);

export function buildExecuteRequest(opts: {
  languageId?: string;
  commands: string[];
  knownID: string;
  runID: string;
  winsize?: { cols?: number; rows?: number };
}) {
  const lid = opts.languageId || "sh";
  const isShellish = SHELLISH.has(lid);
  const req = create(ExecuteRequestSchema, {
    sessionStrategy: SessionStrategy.MOST_RECENT,
    storeStdoutInEnv: true,
    config: {
      languageId: lid,
      background: false,
      fileExtension: "",
      env: [
        `RUNME_ID=${opts.knownID}`,
        "RUNME_RUNNER=v2",
        "TERM=xterm-256color",
      ],
      interactive: true,
      runId: opts.runID,
      knownId: opts.knownID,
    },
    winsize: create(WinsizeSchema, {
      cols: opts.winsize?.cols,
      rows: opts.winsize?.rows,
    }),
  });

  if (opts.commands.length === 0) {
    req.config!.mode = CommandMode.INLINE;
    req.config!.source = {
      case: "commands",
      value: create(ProgramConfig_CommandListSchema, {
        items: ["zsh -l"],
      }),
    };
  } else if (isShellish) {
    req.config!.source = {
      case: "commands",
      value: create(ProgramConfig_CommandListSchema, {
        items: opts.commands,
      }),
    };
    req.config!.mode = CommandMode.INLINE;
  } else {
    req.config!.source = {
      case: "script",
      value: opts.commands.join("\n"),
    };
    req.config!.mode = CommandMode.FILE;
    req.config!.fileExtension = lid;
  }

  return req;
}
