import { Container, Heading, Link, Text } from "@radix-ui/themes";
import { Link as RouterLink } from "react-router-dom";

const NotFound = () => {
  return (
    <Container size="3" style={{ padding: "2rem", textAlign: "center" }}>
      <Heading size="8" mb="4">
        404
      </Heading>
      <Text size="5" color="gray">
        Page not found
      </Text>
      <Text as="p" mt="4">
        The page you're looking for doesn't exist or has been moved.
      </Text>
      <Text as="p" mt="4">
        Click{" "}
        <Link asChild underline="always">
          <RouterLink to="/">here</RouterLink>
        </Link>{" "}
        to go back home.
      </Text>
    </Container>
  );
};

export default NotFound;
