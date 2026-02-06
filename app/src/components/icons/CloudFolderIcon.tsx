import type { SVGProps } from "react";

/**
 * Cloud icon with an overlaid plus sign, used for adding folders from
 * cloud storage (e.g. Google Drive).
 */
export function CloudFolderIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M6.5 19a4.5 4.5 0 0 1-.42-8.98A7 7 0 0 1 19.32 13 4.5 4.5 0 0 1 18.5 22H6.5Z" />
      <path d="M12 13v4" />
      <path d="M10 15h4" />
    </svg>
  );
}
