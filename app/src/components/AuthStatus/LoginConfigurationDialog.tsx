import {
  Button,
  Dialog,
  Flex,
  RadioGroup,
  Text,
  TextField,
} from '@radix-ui/themes'
import { useEffect, useState } from 'react'

import {
  isGoogleServiceAccountEmail,
  type AppLoginConfiguration,
  type AppLoginMode,
} from '../../auth/appLoginConfiguration'

interface LoginConfigurationDialogProps {
  configuration: AppLoginConfiguration
  open: boolean
  busy: boolean
  errorMessage: string | null
  onOpenChange: (open: boolean) => void
  onSave: (configuration: AppLoginConfiguration, login: boolean) => void
}

export default function LoginConfigurationDialog({
  configuration,
  open,
  busy,
  errorMessage,
  onOpenChange,
  onSave,
}: LoginConfigurationDialogProps) {
  const [mode, setMode] = useState<AppLoginMode>(configuration.mode)
  const [serviceAccount, setServiceAccount] = useState(
    configuration.serviceAccount
  )

  useEffect(() => {
    if (!open) {
      return
    }
    setMode(configuration.mode)
    setServiceAccount(configuration.serviceAccount)
  }, [configuration, open])

  const serviceAccountValid =
    mode === 'principal' || isGoogleServiceAccountEmail(serviceAccount)
  const nextConfiguration = { mode, serviceAccount }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="520px">
        <Dialog.Title>Configure application login</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          Choose the identity Runme uses when authenticating to the application.
        </Dialog.Description>

        <RadioGroup.Root
          aria-label="Application login mode"
          value={mode}
          onValueChange={(value) => setMode(value as AppLoginMode)}
          disabled={busy}
        >
          <Flex direction="column" gap="3">
            <Text as="label" size="2">
              <Flex gap="2" align="start">
                <RadioGroup.Item value="principal" />
                <span>
                  <strong>Direct principal</strong>
                  <Text
                    as="span"
                    size="1"
                    color="gray"
                    className="mt-0.5 block"
                  >
                    Sign in directly as the human account selected in Google.
                  </Text>
                </span>
              </Flex>
            </Text>
            <Text as="label" size="2">
              <Flex gap="2" align="start">
                <RadioGroup.Item value="service_account" />
                <span>
                  <strong>Service account</strong>
                  <Text
                    as="span"
                    size="1"
                    color="gray"
                    className="mt-0.5 block"
                  >
                    Use a human login only to mint short-lived Drive and Runme
                    credentials for a scoped service account.
                  </Text>
                </span>
              </Flex>
            </Text>
          </Flex>
        </RadioGroup.Root>

        {mode === 'service_account' ? (
          <label className="mt-4 block space-y-1.5">
            <Text as="div" size="2" weight="medium">
              Service-account email
            </Text>
            <TextField.Root
              aria-label="Service-account email"
              value={serviceAccount}
              disabled={busy}
              onChange={(event) => setServiceAccount(event.target.value)}
              placeholder="name@project.iam.gserviceaccount.com"
            />
            <Text as="div" size="1" color="gray">
              Your human principal must have Service Account Token Creator on
              this account. Generated credentials remain in memory.
            </Text>
            {serviceAccount && !serviceAccountValid ? (
              <Text as="div" size="1" color="red" role="alert">
                Enter a Google service-account email.
              </Text>
            ) : null}
          </label>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className="mt-4 rounded-nb-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {errorMessage}
          </div>
        ) : null}

        <Flex gap="3" mt="5" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" disabled={busy}>
              Cancel
            </Button>
          </Dialog.Close>
          <Button
            variant="soft"
            disabled={busy || !serviceAccountValid}
            onClick={() => onSave(nextConfiguration, false)}
          >
            Save
          </Button>
          <Button
            disabled={busy || !serviceAccountValid}
            onClick={() => onSave(nextConfiguration, true)}
          >
            {busy ? 'Signing in…' : 'Save and sign in'}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
