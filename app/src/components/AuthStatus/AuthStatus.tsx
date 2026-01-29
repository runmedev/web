import { useMemo } from "react";
import { jwtDecode } from "jwt-decode";
import JsonView from "react18-json-view";

import type { SimpleAuthJSONWithHelpers } from "../../auth/types";
import type { ReactNode } from "react";

import AuthButton from "./AuthButton";

import "react18-json-view/src/style.css";

export const AuthStatus = ({
  authData,
  onLogin,
  onLogout,
  description,
}: {
  authData: SimpleAuthJSONWithHelpers | null;
  onLogin: () => void;
  onLogout: () => void;
  description: ReactNode;
}) => {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="flex items-center gap-1 text-2xl font-bold">
        Auth Status
      </h1>
      <div className="max-w-prose">{description}</div>
      <div>Is Authenticated: {authData ? "Yes" : "No"}</div>
      {authData && <div>Is Expired: {authData.isExpired() ? "Yes" : "No"}</div>}
      <AuthButton authData={authData} onLogin={onLogin} onLogout={onLogout} />
      {authData && <AuthData authData={authData} />}
    </div>
  );
};

const AuthData = ({ authData }: { authData: SimpleAuthJSONWithHelpers }) => {
  const { decodedAccessToken, decodedIdToken } = useMemo(() => {
    return {
      decodedAccessToken: jwtDecode(authData.accessToken),
      decodedIdToken: jwtDecode(authData.idToken),
    };
  }, [authData]);

  return (
    <div className="rounded-box border-base-content/5 bg-base-100 w-full overflow-hidden border p-8">
      <table className="table-l table table-fixed">
        <colgroup>
          <col className="w-[300px]" />
          <col />
        </colgroup>
        <tbody>
          <TableRow label="Raw Auth Data" value={<JsonView src={authData} />} />
          <TableRow
            label="Access Token (decoded)"
            value={<JsonView src={decodedAccessToken} />}
          />
          <TableRow
            label="ID Token (decoded)"
            value={<JsonView src={decodedIdToken} />}
          />
          <TableRow label="Token Type" value={authData.tokenType} />
          <TableRow label="Scope" value={authData.scope} />
        </tbody>
      </table>
    </div>
  );
};

const TableRow = ({ label, value }: { label: string; value: ReactNode }) => {
  return (
    <tr>
      <th>{label}</th>
      <td className="break-words">{value}</td>
    </tr>
  );
};

export default AuthStatus;
