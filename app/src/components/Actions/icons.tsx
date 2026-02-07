import {
  PlayIcon as HeroPlayIcon,
  PlusIcon as HeroPlusIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/20/solid";
import { ArrowPathIcon, TrashIcon as HeroTrashIcon, XCircleIcon } from "@heroicons/react/24/outline";

export const PlayIcon = () => (
  <HeroPlayIcon className="h-[15px] w-[15px]" color="currentColor" />
);

export const SpinnerIcon = () => (
  <ArrowPathIcon className="h-[15px] w-[15px]" />
);

export const SuccessIcon = () => (
  <CheckCircleIcon className="h-[15px] w-[15px] text-[#22c55e]" />
);

interface ErrorIconProps {
  exitCode: number;
}

export const ErrorIcon = ({ exitCode }: ErrorIconProps) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="h-[15px] w-[15px]"
  >
    <XCircleIcon className="h-[15px] w-[15px] text-[#ef4444]" />
    <circle cx="12" cy="12" r="10" fill="#ef4444" fillOpacity="0.3" />
    <text
      x="50%"
      y="50%"
      dominantBaseline="middle"
      textAnchor="middle"
      fill="#ef4444"
      fontSize="12"
      fontWeight="bold"
    >
      {exitCode}
    </text>
  </svg>
);

interface PlusIconProps {
  width?: number;
  height?: number;
}

export function PlusIcon({ width = 15, height = 15 }: PlusIconProps) {
  return (
    <HeroPlusIcon
      style={{ width: `${width}px`, height: `${height}px` }}
      color="currentColor"
    />
  );
}

export function SubmitQuestionIcon() {
  return <MagnifyingGlassIcon className="h-7 w-7" />;
}

export const TrashIcon = () => (
  <HeroTrashIcon className="h-[15px] w-[15px]" />
);
