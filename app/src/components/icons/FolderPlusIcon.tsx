import type { SVGProps } from "react";

/**
 * Folder icon with an overlaid plus sign that signals a create/add action.
 * Kept as a standalone React component so it can be re-used anywhere we need
 * to represent "add new folder".
 */
export function FolderPlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3.5 7.5C3.5 6.67 4.17 6 5 6h4.2c.35 0 .69.14.94.39l1.47 1.47c.25.25.59.39.94.39H19c.83 0 1.5.67 1.5 1.5v7.5c0 .83-.67 1.5-1.5 1.5H5c-.83 0-1.5-.67-1.5-1.5V7.5Z" />
      <path d="M3.5 9h17" />
      <path d="M12 11v4" />
      <path d="M10 13h4" />
    </svg>
  );
}
