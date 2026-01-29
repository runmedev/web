import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { getBrowserAdapter } from "../browserAdapter.client";

/**
 * Apps running in-browser auth still need to implement a handler at a callback URL. The
 * `redirectUri` that you pass to the OaiAuthBrowserAdapter should point to a page that
 * can run this logic.
 */
export default function Callback() {
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    const browserAdapter = getBrowserAdapter();
    Promise.all([browserAdapter.handleCallback()]).then(() => {
      if (controller.signal.aborted) return;

      // Navigate back to the main page after handling the callback
      navigate("/");
    });

    // If the user navigates away on their own, cancel the post-callback navigation above
    return () => controller.abort();
  }, []);

  return null;
}
