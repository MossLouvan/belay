// Belay's UI kit — the "Ledger" component set (docs/DESIGN.md).
//
// Imported as `../src/ui` exactly as before. Every legacy export (Card,
// Button, Heading, Sub, Label, Meter, Row, Dot, …) keeps its original props so
// unmigrated screens compile; Card and the pill/elevation-era names survive
// only as deprecated shims. New screens build on the Ledger primitives:
// Section, LedgerRow, MeterSection, MachinePanel and Rule.

export { Txt, Heading, Sub, Label, Micro, Mono, Caption } from './text';
export type { TxtProps, TextTone } from './text';

export { Screen, SafeBottomSpacer, Card, Row, Column, Spacer, Divider } from './layout';
export type { ScreenProps, CardProps, RowProps, ColumnProps, SpaceKey, Elevation } from './layout';

export { Section, LedgerRow, MeterSection, MachinePanel, Rule } from './ledger';
export type { SectionProps, LedgerRowProps, MeterSectionProps, MachinePanelProps } from './ledger';

export { Button, IconButton } from './button';
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from './button';

export { TrackLabel } from './track-label';
export type { TrackLabelProps } from './track-label';
export { trackInks, DISABLED_TRACK_OPACITY } from './track';
export type { TrackInkSet, TrackInks, TrackState } from './track';

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

export { useReducedMotion, usePressScale, useToggleAnimation, usePulse } from './motion';
export type { PressAnimation } from './motion';
