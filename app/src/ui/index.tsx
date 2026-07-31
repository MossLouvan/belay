// Tether's UI kit.
//
// Imported as `../src/ui` exactly as before — this barrel replaces the old
// single-file `ui.tsx`. Every legacy export (Card, Button, Heading, Sub, Label,
// Meter, Row, Dot) keeps its original props; new props are additive.

export { Txt, Heading, Sub, Label, Mono, Caption } from './text';
export type { TxtProps, TextTone } from './text';

export { Screen, SafeBottomSpacer, Card, Row, Column, Spacer, Divider } from './layout';
export type { ScreenProps, CardProps, RowProps, ColumnProps, SpaceKey, Elevation } from './layout';

export { Button, IconButton } from './button';
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from './button';

export { Dot, Meter, Badge, Pill, Banner, Toast, EmptyState, Skeleton } from './feedback';
export type { Status } from './feedback';

export { Input, TextField } from './input';
export type { InputProps } from './input';

export { SegmentedControl, ListItem } from './controls';
export type { SegmentOption, SegmentedControlProps, ListItemProps } from './controls';

export { Sheet, Sheet as Modal } from './sheet';
export type { SheetProps } from './sheet';

export { haptic, setHapticsEnabled, areHapticsEnabled } from './haptics';
export type { HapticTone } from './haptics';

export { useReducedMotion, usePressScale, useToggleAnimation } from './motion';
export type { PressAnimation } from './motion';
