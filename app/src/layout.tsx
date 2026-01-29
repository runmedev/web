import { Flex } from "@radix-ui/themes";
import { CurrentDocInitializer } from "./components/CurrentDocInitializer";
export function AISREContentWrapper({
  children,
  maxHeightScreen = false,
}: {
  children: React.ReactNode;
  maxHeightScreen?: boolean;
}) {
  return (
    <Flex
      direction="column"
      className={`w-screen min-h-screen ${maxHeightScreen ? "max-h-screen" : ""}`}
    >
      <CurrentDocInitializer />
      {children}
    </Flex>
  );
}

function Layout({
  left,
  right,
  maxHeightScreen = false,
}: {
  left?: React.ReactNode;
  right?: React.ReactNode;
  maxHeightScreen?: boolean;
}) {
  return (
    <AISREContentWrapper maxHeightScreen={maxHeightScreen}>
      {/* Main content */}
      <Flex align="stretch" className="w-full flex-1 min-h-0">
        <Flex
          direction="column"
          className="basis-1/3 max-w-[33%] min-w-[280px] p-4 border-r border-gray-200"
        >
          {left ?? <div />}
        </Flex>
        <Flex direction="column" className="flex-1 p-4">
          {right ?? <div />}
        </Flex>
      </Flex>
    </AISREContentWrapper>
  );
}

export default Layout;
