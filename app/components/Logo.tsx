import { StarCloud } from './icons';

interface LogoProps {
  text?: string;
  showText?: boolean;
  className?: string;
}

export function Logo({
  text = 'Starx',
  showText = true,
  className = '',
}: LogoProps) {
  return (
    <div className={`flex items-center gap-3 shrink-0 ${className}`}>
      <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-blue-600 text-white shadow-md shadow-blue-600/25 ring-1 ring-white/10 transition-transform hover:scale-105">
        <StarCloud className="h-[20px] w-[20px] drop-shadow-sm" />
        <span
          className="absolute inset-0 rounded-xl bg-white/10 opacity-0 hover:opacity-100 transition-opacity"
          aria-hidden="true"
        />
      </span>
      {showText && (
        <span className="text-[17px] font-semibold tracking-tight bg-gradient-to-r from-zinc-900 to-zinc-700 dark:from-zinc-100 dark:to-zinc-300 bg-clip-text text-transparent">
          {text}
        </span>
      )}
    </div>
  );
}
