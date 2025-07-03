import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Code } from '@buf/googleapis_googleapis.bufbuild_es/google/rpc/code_pb'
import { Box, Flex, Text } from '@radix-ui/themes'

import { AppBranding } from './App'
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
      const isAuthError =
        runnerError.code === Code.UNAUTHENTICATED ||
        runnerError.code === Code.PERMISSION_DENIED
      if (isAuthError) {
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
              <Text size="5" weight="bold" className="text-black">
                {branding.name}
              </Text>
            </Flex>
          </Link>
          <Flex gap="4">
            <TopNavigation />
          </Flex>
        </Flex>
      </Box>

      {/* Main content */}
      <Flex className="w-full h-[95%] flex-1 gap-2">
        {/* Left */}
        <Box className="flex-none w-[33.33%] flex flex-col h-full p-2 border-r border-gray-400">
          {left ?? <div />}
        </Box>

        {/* Middle */}
        <Box className="flex-none w-[50.00%] flex flex-col h-full p-2 border-r border-gray-400">
          {middle ?? <div />}
        </Box>

        {/* Right */}
        <Box className="flex-none w-[16.67%] flex flex-col h-full p-2">
          {right ?? <div />}
        </Box>
      </Flex>
    </Box>
  )
}

export default Layout
