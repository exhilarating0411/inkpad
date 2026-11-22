import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const Icons = {
  select: (
    <Svg>
      <path d="M5 3l14 8-6 1.5L10 19z" />
    </Svg>
  ),
  pen: (
    <Svg>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z" />
      <path d="M14.5 6.5l3 3" />
    </Svg>
  ),
  highlighter: (
    <Svg>
      <path d="M9 14l-3 3v3h5l3-3" />
      <path d="M9 14l7-10 4 4-10 7z" />
      <path d="M4 21h16" opacity="0.4" />
    </Svg>
  ),
  eraser: (
    <Svg>
      <path d="M8 20h12" />
      <path d="M5.5 15.5l9-9a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 19H8.5z" />
      <path d="M9.5 11.5l5 5" />
    </Svg>
  ),
  text: (
    <Svg>
      <path d="M5 6V4h14v2" />
      <path d="M12 4v16" />
      <path d="M9 20h6" />
    </Svg>
  ),
  image: (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M21 16l-5-5-9 9" />
    </Svg>
  ),
  paste: (
    <Svg>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4.5V3h6v1.5" />
      <path d="M9 11h6M9 15h4" />
    </Svg>
  ),
  undo: (
    <Svg>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </Svg>
  ),
  redo: (
    <Svg>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Svg>
  ),
  finger: (
    <Svg>
      <path d="M9 11V5a1.5 1.5 0 013 0v5" />
      <path d="M12 10V9a1.5 1.5 0 013 0v2" />
      <path d="M15 11a1.5 1.5 0 013 0v3a7 7 0 01-7 7 6 6 0 01-5-3l-2-4a1.5 1.5 0 012.6-1.5L9 15" />
    </Svg>
  ),
  doc: (
    <Svg>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </Svg>
  ),
  inbox: (
    <Svg>
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 01-1 1H5a1 1 0 01-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </Svg>
  ),
  search: (
    <Svg>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  ),
  clock: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  ),
  more: (
    <Svg>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </Svg>
  ),
  grip: (
    <Svg>
      <path d="M5 9h14M5 15h14" />
    </Svg>
  ),
  up: (
    <Svg>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  ),
  down: (
    <Svg>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  ),
  theme: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 000 17z" fill="currentColor" />
    </Svg>
  ),
  menu: (
    <Svg>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  ),
  plus: (
    <Svg>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  minus: (
    <Svg>
      <path d="M5 12h14" />
    </Svg>
  ),
  close: (
    <Svg>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
}
