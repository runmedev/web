import type { OAuthTokenEndpointResponse } from "../../auth/types";

/**
 * Button component to trigger login or logout actions based on authentication status.
 */
export interface AuthButtonProps {
  authData: OAuthTokenEndpointResponse | null;
  onLogin: () => void;
  onLogout: () => void;
}

export function AuthButton({ authData, onLogin, onLogout }: AuthButtonProps) {
  return authData ? (
    <button
      className="p-0 text-sm font-medium text-gray-700 hover:text-gray-900 border-0"
      style={{ padding: 0, backgroundColor: "transparent" }}
      onClick={onLogout}
    >
      Logout
    </button>
  ) : (
    <button
      className="p-0 text-sm font-medium text-gray-700 hover:text-gray-900 border-0"
      style={{ padding: 0, backgroundColor: "transparent" }}
      onClick={onLogin}
    >
      Login
    </button>
  );
}

export default AuthButton;
