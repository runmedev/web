import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Code } from '@buf/googleapis_googleapis.bufbuild_es/google/rpc/code_pb'
import { Box, Flex, Text } from '@radix-ui/themes'

import { AppBranding } from './App'
import AppConsole from './components/AppConsole/AppConsole'
import TopNavigation from './components/TopNavigation'
import { useSettings } from './contexts/SettingsContext'

function Layout({
  branding,
  left,
  middle,
  right,
}: {
  branding: AppBranding
  left?: React.ReactNode
  middle?: React.ReactNode
  right?: React.ReactNode
}) {
  const navigate = useNavigate()
  const { settings, runnerError } = useSettings()

  useEffect(() => {
    if (!runnerError) {
      return
    }

    const settingsPath = '/settings'
    const currentPath = window.location.pathname
    if (
      currentPath === settingsPath ||
      currentPath === '/login' ||
      currentPath === '/oidc/login'
    ) {
      return
    }

    const loginUrl = settings.requireAuth ? '/oidc/login' : '/login'

    if (!(runnerError instanceof Error) && !(runnerError instanceof Event)) {
      // only do this for unauthenticated errors, unauthorized is not an IdP-related error
      const isAuthnError = runnerError.code === Code.UNAUTHENTICATED
      if (isAuthnError && window.location.pathname !== loginUrl) {
        window.location.href = loginUrl
      } else {
        navigate(settingsPath)
      }
      return
    }

    navigate(settingsPath)
  }, [runnerError, settings.requireAuth, navigate])

  return (
    <Box className="w-screen h-[95vh] max-w-[95%] mx-auto flex flex-col">
      {/* Navbar, links are just a facade for now */}
      <Box className="w-full p-3 mb-1 border-b">
        <Flex align="center" justify="between">
          <Link to="/">
            <Flex align="center" gap="2">
              <img src={branding.logo} className="h-6 w-6" />
              <Text size="5" weight="bold">
                {branding.name}
              </Text>
            </Flex>
          </Link>
          <Flex gap="4">
            <TopNavigation />
          </Flex>
        </Flex>
      </Box>

      {/* Main content with bottom console */}
      <Flex className="w-full flex-1 flex-col gap-2 min-h-0">
        <Flex className="w-full flex-1 gap-2 min-h-0">
          {/* Left */}
          <Box className="flex-none w-[33.33%] flex flex-col h-full p-2 border-r border-gray-400 overflow-auto">
            {left ?? <div />}
          </Box>

          {/* Middle */}
          <Box className="flex-none w-[50.00%] flex flex-col h-full p-2 border-r border-gray-400 overflow-auto">
            {middle ?? <div />}
          </Box>

          {/* Right */}
          <Box className="flex-none w-[16.67%] flex flex-col h-full p-2 overflow-auto">
            {right ?? <div />}
          </Box>
        </Flex>

        {/* Console spanning the full width at the bottom */}
        <Box className="w-full min-h-[180px] max-h-[40vh] border border-gray-400 rounded bg-black text-white p-2 overflow-hidden">
          <AppConsole />
        </Box>
      </Flex>
    </Box>
  )
}

export default Layout
