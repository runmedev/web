import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSettings } from "../../contexts/SettingsContext";

export default function Settings() {
  const navigate = useNavigate();
  const { settings, updateSettings, runnerError, defaultSettings } =
    useSettings();
  const [saveSettingsPending, setSaveSettingsPending] = useState(false);
  const [endpoint, setEndpoint] = useState(settings.agentEndpoint);  
  const [invertOrder, setInvertOrder] = useState(settings.webApp.invertedOrder);

  const handleSave = () => {
    updateSettings({
      agentEndpoint: endpoint,
      webApp: {
        runner: "",
        reconnect: settings.webApp.reconnect,
        invertedOrder: invertOrder,
      },
    });
    setSaveSettingsPending(true);
  };

  useEffect(() => {
    if (!saveSettingsPending) {
      return;
    }
    setSaveSettingsPending(false);
    if (runnerError) {
      navigate("/");
    }
  }, [runnerError, saveSettingsPending, navigate]);

  const handleRevert = () => {
    setEndpoint(defaultSettings.agentEndpoint);    
    setInvertOrder(defaultSettings.webApp.invertedOrder);
  };

  const runnerErrorMessage = useMemo(() => {
    if (!runnerError) {
      return undefined;
    }

    // Check if runnerError is an error-like object with a message property
    if (
      !runnerError ||
      typeof runnerError !== "object" ||
      !("message" in runnerError)
    ) {
      return undefined;
    }

    return runnerError.message;
  }, [runnerError]);

  const isChanged =
    endpoint !== settings.agentEndpoint ||    
    invertOrder !== settings.webApp.invertedOrder;
  return (
    <div className="w-full mx-auto">
      <h2 className="text-lg font-semibold text-nb-text mb-2">
        Settings
      </h2>

      <div className="mt-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-nb-text">
              Agent Endpoint Configuration
            </h3>
            <p className="text-sm text-nb-text-muted">
              Configure the endpoint URL for the AI agent. Changes will take
              effect after saving.
            </p>
            <textarea
              className="w-full rounded-nb-sm border border-nb-cell-border bg-white px-3 py-2 text-sm text-nb-text font-body focus:outline-none focus:ring-1 focus:ring-nb-accent focus:border-nb-accent"
              placeholder="Enter AI endpoint URL"
              value={endpoint}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setEndpoint(e.target.value)
              }
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-4">
          <button
            type="button"
            className="rounded-nb-sm border border-nb-cell-border bg-white px-3 py-1.5 text-sm text-nb-text-muted hover:bg-nb-surface-2 transition-colors duration-150"
            onClick={handleRevert}
          >
            Revert
          </button>
          <button
            type="button"
            className="rounded-nb-sm bg-nb-accent px-3 py-1.5 text-sm text-white hover:opacity-90 transition-opacity duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleSave}
            disabled={!isChanged}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
