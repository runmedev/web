import { Link } from 'react-router-dom'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { PersonIcon } from '@radix-ui/react-icons'
import { Flex, Text } from '@radix-ui/themes'
import { jwtDecode } from 'jwt-decode'
import md5 from 'md5'
import { Avatar } from 'radix-ui'

import { useCell } from '../contexts/CellContext'
import { getSessionToken } from '../token'

const getGravatarUrl = (size = 24) => {
  const token = getSessionToken() || 'unauthenticated'

  try {
    const decodedToken = jwtDecode(token)
    const sub = decodedToken.sub || 'unauthenticated'
    const hash = md5(sub.trim().toLowerCase())
    return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err) {
    return 'unauthenticated'
  }
}

const UserAvatar = () => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <span>
        <Avatar.Root className="inline-flex size-[24px] select-none items-center justify-center overflow-hidden rounded-full bg-blackA1 align-middle cursor-pointer">
          <Avatar.Image
            className="size-full rounded-[inherit] object-cover"
            src={getGravatarUrl()}
          />
          <Avatar.Fallback
            className="leading-1 flex size-full items-center justify-center bg-white text-[15px] font-medium text-violet11"
            delayMs={600}
          >
            <PersonIcon />
          </Avatar.Fallback>
        </Avatar.Root>
      </span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      sideOffset={8}
      className="z-50 min-w-[120px] rounded-md bg-white p-2 shadow-lg border border-gray-200"
    >
      <DropdownMenu.Item asChild>
        <a
          href="/oidc/logout"
          className="block w-full px-3 py-2 text-md text-gray-700 hover:bg-gray-100 rounded cursor-pointer"
        >
          Logout
        </a>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
)

const TopNavigation = () => {
  const { resetSession, exportDocument } = useCell()
  return (
    <>
      <Link
        to="#"
        onClick={(e) => {
          e.preventDefault()
          exportDocument()
        }}
      >
        <Flex className="cursor-pointer" gap="1" align="center">
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.50005 1.04999C7.74858 1.04999 7.95005 1.25146 7.95005 1.49999V8.41359L10.1819 6.18179C10.3576 6.00605 10.6425 6.00605 10.8182 6.18179C10.994 6.35753 10.994 6.64245 10.8182 6.81819L7.81825 9.81819C7.64251 9.99392 7.35759 9.99392 7.18185 9.81819L4.18185 6.81819C4.00611 6.64245 4.00611 6.35753 4.18185 6.18179C4.35759 6.00605 4.64251 6.00605 4.81825 6.18179L7.05005 8.41359V1.49999C7.05005 1.25146 7.25152 1.04999 7.50005 1.04999ZM2.5 10C2.77614 10 3 10.2239 3 10.5V12C3 12.5539 3.44565 13 3.99635 13H11.0012C11.5529 13 12 12.5528 12 12V10.5C12 10.2239 12.2239 10 12.5 10C12.7761 10 13 10.2239 13 10.5V12C13 13.1041 12.1062 14 11.0012 14H3.99635C2.89019 14 2 13.103 2 12V10.5C2 10.2239 2.22386 10 2.5 10Z"
              fill="currentColor"
            ></path>
          </svg>
          <Text>Export</Text>
        </Flex>
      </Link>
      <Link to="/" onClick={resetSession}>
        <Flex className="cursor-pointer" gap="1" align="center">
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.5 0.875C7.77614 0.875 8 1.09886 8 1.375V7.5H14.125C14.4011 7.5 14.625 7.72386 14.625 8C14.625 8.27614 14.4011 8.5 14.125 8.5H8V14.625C8 14.9011 7.77614 15.125 7.5 15.125C7.22386 15.125 7 14.9011 7 14.625V8.5H0.875C0.598858 8.5 0.375 8.27614 0.375 8C0.375 7.72386 0.598858 7.5 0.875 7.5H7V1.375C7 1.09886 7.22386 0.875 7.5 0.875Z"
              fill="currentColor"
            />
          </svg>
          <Text>New Session</Text>
        </Flex>
      </Link>
      <Link to="/settings">
        <Flex className="cursor-pointer" gap="1" align="center">
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M7.07095 0.650238C6.67391 0.650238 6.32977 0.925096 6.24198 1.31231L6.0039 2.36247C5.6249 2.47269 5.26335 2.62363 4.92436 2.81013L4.01335 2.23585C3.67748 2.02413 3.23978 2.07312 2.95903 2.35386L2.35294 2.95996C2.0722 3.2407 2.0232 3.6784 2.23493 4.01427L2.80942 4.92561C2.62307 5.2645 2.47227 5.62594 2.36216 6.00481L1.31209 6.24287C0.924883 6.33065 0.650024 6.6748 0.650024 7.07183V7.92897C0.650024 8.32601 0.924883 8.67015 1.31209 8.75794L2.36228 8.99603C2.47246 9.375 2.62335 9.73652 2.80979 10.0755L2.2354 10.9867C2.02367 11.3225 2.07267 11.7602 2.35341 12.041L2.95951 12.6471C3.24025 12.9278 3.67795 12.9768 4.01382 12.7651L4.92506 12.1907C5.26384 12.377 5.62516 12.5278 6.0039 12.6379L6.24198 13.6881C6.32977 14.0753 6.67391 14.3502 7.07095 14.3502H7.92809C8.32512 14.3502 8.66927 14.0753 8.75705 13.6881L8.99505 12.6383C9.37411 12.5282 9.73573 12.3773 10.0748 12.1909L10.986 12.7653C11.3218 12.977 11.7595 12.928 12.0403 12.6473L12.6464 12.0412C12.9271 11.7604 12.9761 11.3227 12.7644 10.9869L12.1902 10.076C12.3768 9.73688 12.5278 9.37515 12.638 8.99596L13.6879 8.75794C14.0751 8.67015 14.35 8.32601 14.35 7.92897V7.07183C14.35 6.6748 14.0751 6.33065 13.6879 6.24287L12.6381 6.00488C12.528 5.62578 12.3771 5.26414 12.1906 4.92507L12.7648 4.01407C12.9766 3.6782 12.9276 3.2405 12.6468 2.95975L12.0407 2.35366C11.76 2.07292 11.3223 2.02392 10.9864 2.23565L10.0755 2.80989C9.73622 2.62328 9.37437 2.47229 8.99505 2.36209L8.75705 1.31231C8.66927 0.925096 8.32512 0.650238 7.92809 0.650238H7.07095ZM4.92053 3.81251C5.44724 3.44339 6.05665 3.18424 6.71543 3.06839L7.07095 1.50024H7.92809L8.28355 3.06816C8.94267 3.18387 9.5524 3.44302 10.0794 3.81224L11.4397 2.9547L12.0458 3.56079L11.1887 4.92117C11.558 5.44798 11.8173 6.0575 11.9332 6.71638L13.5 7.07183V7.92897L11.9334 8.28444C11.8176 8.94342 11.5585 9.55301 11.1892 10.0798L12.0459 11.4394L11.4398 12.0455L10.0797 11.1889C9.55252 11.5583 8.94242 11.8176 8.28355 11.9334L7.92809 13.5002H7.07095L6.71543 11.9332C6.0569 11.8174 5.44772 11.5582 4.92116 11.189L3.56055 12.0455L2.95445 11.4394L3.81107 10.0794C3.4418 9.55266 3.18265 8.94307 3.06681 8.28395L1.50002 7.92897V7.07183L3.06697 6.71632C3.18305 6.05684 3.44247 5.44693 3.81203 4.91979L2.95424 3.56079L3.56034 2.9547L4.92053 3.81251ZM9.02496 7.50008C9.02496 8.34226 8.34223 9.02499 7.50005 9.02499C6.65786 9.02499 5.97513 8.34226 5.97513 7.50008C5.97513 6.65789 6.65786 5.97516 7.50005 5.97516C8.34223 5.97516 9.02496 6.65789 9.02496 7.50008ZM9.97496 7.50008C9.97496 8.86866 8.86863 9.97499 7.50005 9.97499C6.13146 9.97499 5.02513 8.86866 5.02513 7.50008C5.02513 6.13149 6.13146 5.02516 7.50005 5.02516C8.86863 5.02516 9.97496 6.13149 9.97496 7.50008Z"
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
            />
          </svg>
          <Text>Settings</Text>
        </Flex>
      </Link>
      <UserAvatar />
    </>
  )
}

export default TopNavigation
