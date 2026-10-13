/** The One Launch mark, single colour (currentColor). Same shape as build/icon-mono.svg. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M253 279A348 348 0 0 0 253 745A48 48 0 0 0 325 681A252 252 0 0 1 325 343A48 48 0 0 0 253 279ZM440 852A348 348 0 0 0 843 620A48 48 0 0 0 752 590A252 252 0 0 1 460 758A48 48 0 0 0 440 852ZM843 404A348 348 0 0 0 440 172A48 48 0 0 0 460 266A252 252 0 0 1 752 434A48 48 0 0 0 843 404ZM422 386V638Q422 672 451 655L649 538Q692 512 649 486L451 369Q422 352 422 386Z"
      />
    </svg>
  );
}
