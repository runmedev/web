import {
  type ConfigureRunnerAuthRequest,
  clearRunnerAuth,
  configureRunnerAuth,
  getRunnerAuthStatus,
} from '../../auth/runnerAuth'
import {
  type WorkloadIdentityDriveConfig,
  configureGoogleWorkloadIdentity,
  getWorkloadIdentityAccessToken,
  getWorkloadIdentityConfig,
} from '../../auth/workloadIdentity'
import { getRunnersManager } from './runnersManager'

/** Configure the normal runner registry and its memory-only signer together. */
export async function configureRunner(input: ConfigureRunnerAuthRequest) {
  const status = await configureRunnerAuth(input)
  const endpoint = new URL(status.runnerBaseUrl!)
  endpoint.protocol = 'wss:'
  endpoint.pathname = '/ws'
  getRunnersManager().update(status.runnerName, endpoint.toString())
  if (getWorkloadIdentityConfig()?.runnerName === status.runnerName)
    void getWorkloadIdentityAccessToken().catch(() => {
      /* Status reports the error. */
    })
  return status
}

/** Prime unattended Drive authentication without exposing the returned token. */
export async function configureWorkloadDrive(
  input: WorkloadIdentityDriveConfig
) {
  configureGoogleWorkloadIdentity(input)
  await getWorkloadIdentityAccessToken()
  return {
    configured: true,
    serviceAccountEmail: input.expectedServiceAccountEmail,
  }
}

const textField = { type: 'string', minLength: 1 }
const nameSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { runnerName: textField },
  required: ['runnerName'],
}

/** Dedicated tools keep signing inputs out of ExecuteCode/App Console history.
 * Errors are intentionally constant: crypto and request errors can echo input.
 */
export function runnerAuthTools() {
  const definitions = [
    {
      name: 'configureRunnerAuth',
      title: 'Configure Runner Authentication',
      description:
        'Import a provisioned ES256 signing key for a runner. Sensitive privateKeyPkcs8Pem must come from a trusted local file, never notebook output. Returns redacted status only.',
      inputSchema: {
        ...nameSchema,
        properties: {
          runnerName: textField,
          runnerBaseUrl: textField,
          issuer: textField,
          audience: textField,
          subject: textField,
          keyId: textField,
          privateKeyPkcs8Pem: { ...textField, writeOnly: true },
        },
        required: [
          'runnerName',
          'runnerBaseUrl',
          'issuer',
          'audience',
          'subject',
          'keyId',
          'privateKeyPkcs8Pem',
        ],
      },
      run: (input: Record<string, unknown>) =>
        configureRunner(input as unknown as ConfigureRunnerAuthRequest),
    },
    {
      name: 'getRunnerAuthStatus',
      title: 'Get Runner Authentication Status',
      description: 'Read runner authentication status without keys or tokens.',
      inputSchema: nameSchema,
      run: (input: Record<string, unknown>) =>
        getRunnerAuthStatus(input as { runnerName: string }),
    },
    {
      name: 'clearRunnerAuth',
      title: 'Clear Runner Authentication',
      description:
        'Clear this tab’s in-memory runner signing credential. Does not revoke runner trust or fall back to human credentials.',
      inputSchema: nameSchema,
      run: (input: Record<string, unknown>) => {
        clearRunnerAuth(input as { runnerName: string })
        return { cleared: true }
      },
    },
    {
      name: 'configureGoogleWorkloadIdentity',
      title: 'Configure Google Workload Identity',
      description:
        'Select unattended Drive authentication using an already configured runner. Returns status only, never a Google token.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authFlow: { const: 'workload_identity' },
          runnerName: textField,
          expectedServiceAccountEmail: textField,
          scopes: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: textField,
          },
          lifetimeSeconds: { type: 'integer', minimum: 60, maximum: 3600 },
        },
        required: [
          'authFlow',
          'runnerName',
          'expectedServiceAccountEmail',
          'scopes',
        ],
      },
      run: (input: Record<string, unknown>) =>
        configureWorkloadDrive(input as unknown as WorkloadIdentityDriveConfig),
    },
  ]
  return definitions.map(({ run, ...tool }) => ({
    ...tool,
    annotations: {
      readOnlyHint: tool.name === 'getRunnerAuthStatus',
      untrustedContentHint: false,
    },
    execute: async (input: Record<string, unknown>) => {
      try {
        return JSON.stringify(await run(input))
      } catch {
        throw new Error(
          'Runner authentication operation failed; verify configuration and availability'
        )
      }
    },
  }))
}
