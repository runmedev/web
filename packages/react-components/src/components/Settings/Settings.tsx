import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  Box,
  Button,
  Callout,
  Flex,
  Switch,
  Text,
  TextArea,
} from '@radix-ui/themes'

import { useSettings } from '../../contexts/SettingsContext'

export default function Settings() {
  const navigate = useNavigate()
  const { settings, updateSettings, runnerError, defaultSettings } =
    useSettings()
  const [saveSettingsPending, setSaveSettingsPending] = useState(false)
  const [endpoint, setEndpoint] = useState(settings.agentEndpoint)
  const [runnerEndpoint, setRunnerEndpoint] = useState(settings.webApp.runner)
  const [invertOrder, setInvertOrder] = useState(settings.webApp.invertedOrder)

  const handleSave = () => {
    updateSettings({
      agentEndpoint: endpoint,
      webApp: {
        runner: runnerEndpoint,
        reconnect: settings.webApp.reconnect,
        invertedOrder: invertOrder,
      },
    })
    setSaveSettingsPending(true)
  }

  useEffect(() => {
    if (!saveSettingsPending) {
      return
    }
    setSaveSettingsPending(false)
    if (runnerError) {
      navigate('/')
    }
  }, [runnerError, saveSettingsPending, navigate])

  const handleRevert = () => {
    setEndpoint(defaultSettings.agentEndpoint)
    setRunnerEndpoint(defaultSettings.webApp.runner)
    setInvertOrder(defaultSettings.webApp.invertedOrder)
  }

  const runnerErrorMessage = useMemo(() => {
    if (!(runnerError instanceof Error)) {
      return undefined
    }
    return runnerError.message
  }, [runnerError])

  const isChanged =
    endpoint !== settings.agentEndpoint ||
    runnerEndpoint !== settings.webApp.runner ||
    invertOrder !== settings.webApp.invertedOrder

  return (
    <Box className="w-full mx-auto">
      <Text size="5" weight="bold" className="mb-2">
        Settings
      </Text>

      <Box className="mt-4">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="2">
            <Text size="3" weight="bold">
              Agent Endpoint Configuration
            </Text>
            <Text size="2" color="gray">
              Configure the endpoint URL for the AI agent. Changes will take
              effect after saving.
            </Text>
            <TextArea
              size="3"
              placeholder="Enter AI endpoint URL"
              value={endpoint}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setEndpoint(e.target.value)
              }
            />
          </Flex>

          {/* Display runner authentication error if present, specific to Runner Endpoint Configuration */}
          <Flex direction="column" gap="2">
            <Text size="3" weight="bold">
              Runner Endpoint Configuration
            </Text>
            <Text size="2" color="gray">
              Configure the WebSocket endpoint URL for the runner. Changes will
              take effect after saving.
            </Text>
            {runnerError && (
              <Callout.Root color="red">
                <Callout.Text className="font-bold">
                  Runner error
                  {runnerErrorMessage ? ': ' + runnerErrorMessage : ''}
                </Callout.Text>
              </Callout.Root>
            )}
            <TextArea
              size="3"
              placeholder="Enter Runner WebSocket endpoint URL"
              value={runnerEndpoint}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                setRunnerEndpoint(e.target.value)
              }
            />
            <Text size="2" color="gray">
              Revert will reset endpoints to the default values, including
              protocol http(s), based on the current page.
            </Text>
          </Flex>
          <Flex direction="column" gap="2">
            <Text size="3" weight="bold">
              User Experience Mode
            </Text>
            <Text as="label" size="2">
              <Flex gap="2">
                Document Mode
                <Switch
                  checked={invertOrder}
                  onCheckedChange={setInvertOrder}
                />
                Console Mode
              </Flex>
            </Text>
          </Flex>
        </Flex>

        <Flex gap="3" justify="end" mt="4">
          <Button size="2" variant="soft" onClick={() => navigate('/')}>
            Back
          </Button>
          <Button size="2" variant="soft" onClick={handleRevert}>
            Revert
          </Button>
          <Button size="2" onClick={handleSave} disabled={!isChanged}>
            Save
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
