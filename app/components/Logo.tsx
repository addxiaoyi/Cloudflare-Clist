import type { SVGProps } from 'react';
import { Cloud } from './icons';

type IconProps = SVGProps<SVGSVGElement>;

interface LogoProps extends IconProps {
  text?: string;
  showText?: boolean;
}

export function Logo({ text = 'Starx', showText = true, className = '', ...props }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 shrink-0 ${className}`}>
      <span
        className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/20"
        {...props}
      >
        <Cloud className="h-[18px] w-[18px]" />
      </span>
      {showText && (
        <span className="text-lg font-bold tracking-tight">{text}</span>
      )}
    </div>
  );
}
