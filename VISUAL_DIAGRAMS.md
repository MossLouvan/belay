# Visual Comparison: Before & After

## Carabiner Cross-Section View

### BEFORE (Simple Outline)
```
     ┌────┐  ← Gate bar (flat)
    ╱      ╲
   │        │  ← Single border outline
   │        │     No depth or shine
  │          │
  │          │
  │          │
   │        │
    ╲      ╱
     └────┘
```

### AFTER (Realistic Metal Hardware)
```
     ┌────┐  ← Gate bar with highlight
    ╱░     ╲     ░ = inner highlight (metallic shine)
   │░       │▓   ▓ = shadow layer (depth)
   │        ⫽    ⫽ = gate opening gap
  │          │▓
  │          │▓
  │█         │▓  █ = spine emphasis (thickness)
   │        │▓
    ╲      ╱▓
     └────┘▓
       ▓▓▓▓
```

## Rope Cross-Section (Straight Segment)

### BEFORE (Flat Line)
```
     ███████████  ← Single solid View (3pt)
```

### AFTER (Twisted Strands with Depth)
```
       ░░░░░░░░  ← Left highlight strand (35% white)
     ▓▓▓▓▓▓▓▓▓▓  ← Shadow layer (15% black, offset)
     ██████████  ← Main rope body (accent blue)
      ░░░░░░░░░  ← Right subtle strand (15% white)
```
*All layers overlap to create 3D appearance of twisted rope*

## Splash Screen Rope (Curved Arc)

### BEFORE (Single Border Circle)
```
        ╭─────╮
       ╱       ╲
      │         │  ← 4pt border on circle
     │           │    (flat, no texture)
    │      ○      │  ○ = carabiner at sag point
     │           │
      │         │
       ╲       ╱
        ╰─────╯
```

### AFTER (Layered Arc with Depth)
```
        ╭─────╮
       ╱░ ░ ░ ░╲   ░ = highlight strands
      │▓▓▓▓▓▓▓▓│  ▓ = shadow layer  
     │███████████│ █ = main rope body
    │      ⊕      │ ⊕ = realistic 3D carabiner
     │███████████│
      │         │
       ╲       ╱
        ╰─────╯
```
*6pt thickness with 4 overlapping layers creates twisted rope texture*

## Brand Animation Segments

### BEFORE (Disconnected Dots)
```
Start:    ○ ○ ○ ○ ○ ○  ← Small segments with gaps
           ○ ○ ○ ○ ○     4pt × 8pt each
            ○ ○ ○ ○       Flat appearance
             ○ ○ ○
              ○ ○
               ○
```

### AFTER (Continuous Layered Rope)
```
Start:    ●─●─●─●─●─●  ← 4 layers per segment
           ●─●─●─●─●     Shadow + main + 2 highlights
            ●─●─●─●       5pt × 10pt each (overlap)
             ●─●─●        Appears continuous
              ●─●
               ●
```

## Animation Sequence (Splash Screen)

### Timeline
```
0ms    Rope starts offscreen (translateY: -100)
       Carabiner hidden (opacity: 0, translateY: -50)

150ms  ┌─── Rope drops in (spring animation)
       │    
       │    
800ms  │    Carabiner fades in (opacity: 0 → 1)
       │    Carabiner slides down rope (spring animation)
       │    
       │    
1200ms │    Wordmark fades in and rises
       │    
       └──> All elements at rest

Reduced Motion:
       All elements appear instantly at final positions
```

## Color Palette

### Theme Colors Used
```
Dark Mode (default):
  Rope & Carabiner:  #5B9CF8  (theme.colors.accentGraphic)
  Background:        #0A0A0C  (theme.colors.bg)
  
Light Mode:
  Rope & Carabiner:  #2E7CF6  (theme.colors.accentGraphic)
  Background:        #F6F8FB  (theme.colors.bg)

Depth Layers (both modes):
  Shadows:           rgba(0, 0, 0, 0.15-0.2)
  Highlights:        rgba(255, 255, 255, 0.15-0.4)
```

## Size Variations

### Carabiner Scales Perfectly
```
Notifications:  24pt × 31pt  (size: 24)
Setup Flow:     32pt × 42pt  (size: 32)
Splash Screen:  40pt × 52pt  (size: 40)

All use same component, scale proportionally
All maintain 3D depth and gate detail
```

### Rope Thickness by Context
```
Notification segment:  4pt
Setup flow (straight): 5pt  
Splash screen (curved): 6pt
Brand animation:        5pt

Thicker = more prominent = more visual weight
All use same layering technique
```

---

## Key Visual Improvements

1. **Rope Texture**: Twisted strands visible through layered highlights
2. **Depth Perception**: Shadow layers create 3D appearance
3. **Metal Shine**: White highlights on carabiner suggest metallic surface
4. **Continuous Curve**: No disconnected segments, smooth arcs
5. **Gate Detail**: Visible opening and mechanism on carabiner
6. **Consistent Style**: All components use same technique

The result: **Belay's climbing gear looks REAL**.
