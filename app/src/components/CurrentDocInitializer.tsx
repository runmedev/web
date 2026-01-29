import { useEffect } from "react";
import { useCurrentDoc } from "../contexts/CurrentDocContext";

// Ensure we never start with a local:// document in the query param, since it
// isn't shareable across sessions.
export function CurrentDocInitializer() {
  const { setCurrentDoc } = useCurrentDoc();

  useEffect(() => { 
    // At startup strip any local-only document references from the URL so
    // downstream logic never tries to load them.
    const params = new URLSearchParams(window.location.search);
    const docParam = params.get("doc");
    console.log("CurrentDocInitializer running", { docParam });
    if (docParam && docParam.startsWith("local://")) {
      setCurrentDoc(null);
    }
  }, [setCurrentDoc]);

  return null;
}
