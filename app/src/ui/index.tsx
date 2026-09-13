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

export { Contours } from './contours';
export type { ContoursProps } from './contours';

export { GlassState } from './glass-state';
export type { GlassStateProps, GlassStateAction, GlassStatus } from './glass-state';

export { Dot, Meter, Badge, Banner, Toast, EmptyState, Skeleton } from './feedback';
export type { Status } from './feedback';

export { ConnectionStatus } from './connection-status';
export type { ConnectionStatusProps } from './connection-status';
export { describeConnection, describeSurface } from './connection-view';
export type { ConnectionPhase, ConnectionView, SurfaceExtras, SurfacePhase, SurfaceView } from './connection-view';

export { Input, TextField } from './input';
export type { InputProps } from './input';

export { Composer } from './composer';
export type { ComposerProps, ComposerAction, ComposerDismiss } from './composer';

export { SegmentedControl, ListItem } from './controls';
export type { SegmentOption, SegmentedControlProps, ListItemProps } from './controls';

export { Sheet, Sheet as Modal } from './sheet';
export type { SheetProps } from './sheet';

export { haptic, setHapticsEnabled, areHapticsEnabled } from './haptics';
export type { HapticTone } from './haptics';

export { useReducedMotion, useToggleAnimation, useEntrance, usePulse, useSpringPress, useMorphTransition, useStatusPulse, useSuccessCelebration } from './motion';
export { Carabiner } from './carabiner';
export type { CarabinerProps } from './carabiner';
export { RopeStrand } from './rope-strand';
export type { RopeStrandProps } from './rope-strand';
export type { PressAnimation, EntranceStyle } from './motion';

export { GlassPanel } from './glass';
export type { GlassPanelProps } from './glass';

export { StatusBadge, TransitionRing } from './status-badge';
export type { StatusBadgeProps, StatusBadgeVariant } from './status-badge';

export { BelugaAvatar } from './beluga-avatar';
export type { BelugaAvatarProps } from './beluga-avatar';

export { useKeyboardLift, useKeyboardShown } from './keyboard-lift';
export type { KeyboardLift, KeyboardLiftOptions } from './keyboard-lift';
export { ErrorBoundary } from './error-boundary';
export type { ErrorBoundaryProps } from './error-boundary';
export { KeyboardAvoider } from './keyboard-avoider';
export type { KeyboardAvoiderProps } from './keyboard-avoider';
export { clearsKeyboard, keyboardInset, keyboardOverlap, keyboardShown } from './keyboard';
export type { KeyboardFrame } from './keyboard';
