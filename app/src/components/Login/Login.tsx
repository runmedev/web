import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { Button, Callout } from "@radix-ui/themes";

import { Code } from "@buf/googleapis_googleapis.bufbuild_es/google/rpc/code_pb";
import { useSettings } from "../../contexts/SettingsContext";

export default function Login() {
  const { runnerError } = useSettings();
  const [searchParams] = useSearchParams();
  const error = useMemo(() => {
    if (runnerError && !(runnerError instanceof Error)) {
      return Code[runnerError.code] ?? runnerError.code;
    }
    return searchParams.get("error");
  }, [runnerError, searchParams]);
  const errorDescription = useMemo(() => {
    if (runnerError && !(runnerError instanceof Error)) {
      return runnerError.message;
    }
    return searchParams.get("error_description");
  }, [runnerError, searchParams]);

  const handleLogin = () => {
    // Navigate to /oidc/login to trigger OIDC-flow
    window.location.href = "/oidc/login";
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      {error && (
        <Callout.Root color="red">
          <Callout.Text className="font-bold">Error: {error}</Callout.Text>
          {errorDescription && <Callout.Text>{errorDescription}</Callout.Text>}
        </Callout.Root>
      )}
      <Button size="4" onClick={handleLogin} className="cursor-pointer">
        Login
      </Button>
    </div>
  );
}
