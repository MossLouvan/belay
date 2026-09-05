# Realistic Climbing Visuals — Technical Overview

## Summary
Transformed Belay's climbing motif from flat, simplistic shapes into realistic gear with proper depth and texture.

---

## 🧗 Carabiner Improvements

### Before
- Simple outline with one border
- Flat gate bar on top
- No depth or metallic appearance
- Basic D-shape

### After  
- **Shadow layer** for depth (offset below)
- **Main body** with proper D-shape (wider spine on left)
- **Inner highlight** (top-left) for metallic shine
- **Gate opening gap** visible on right side
- **Gate bar** positioned correctly with own highlight
- **Spine emphasis** (bottom left) showing thickness variation

### Visual Result
The carabiner now appears as **real metal hardware** with:
- 3D depth from layered shadows/highlights
- Visible gate mechanism (where rope clips in)
- Metallic sheen from white highlights at ~25-40% opacity
- Proper offset D-shape matching actual climbing carabiners

---

## 🪢 Rope Improvements

### Before — Splash Screen
- Single 4pt border on circular View
- Flat appearance
- No texture or depth

### After — Splash Screen
- **6pt thickness** (increased from 4pt)
- **4 layered Views**:
  1. Shadow layer (offset, black @ 20% opacity)
  2. Dark strand (slightly transparent, creates twist pattern)
  3. Main rope body (accent blue)
  4. Two highlight strands (white @ 35% and 15% opacity)
- Continuous curve under tension
- Appears as **actual climbing rope** with visible strands

### Before — Straight Rope (Setup Flow)
- Single 3pt View with background color
- Plain line appearance

### After — Straight Rope (Setup Flow)
- **5pt width** (increased from 3pt)
- **4 layered elements**:
  1. Shadow (offset right+down, black @ 15%)
  2. Main body (accent blue, full width)
  3. Left highlight strand (35% white, narrow)
  4. Right subtle strand (15% white, very narrow)
- Creates **twisted rope texture**
- All layers animate together

### Before — Brand Animation
- 20 disconnected segments (4pt × 8pt rectangles)
- Flat appearance
- Visible gaps between segments

### After — Brand Animation
- Same 20 segments, but each renders **4 layers**
- Shadow, main body, two highlights per segment
- 10pt height (increased from 8pt) for better overlap
- Appears as **continuous rope** with depth
- No visible disconnection

### Before — Notification Rope
- Single 3pt View
- Plain segment

### After — Notification Rope
- 4pt width with 4 layers
- Matches other rope rendering
- Consistent realistic appearance

---

## 🎨 Visual Technique

All improvements use the same **layering approach**:

1. **Shadow layer**: Offset position (usually +1 right, +1 down), black @ 15-20% opacity
2. **Main body**: Full size, theme accent color
3. **Highlight strands**: Offset positions, white @ 15-40% opacity
4. **Multiple layers**: Create depth through composition

### Why This Works
- **No complex graphics**: Pure React Native Views with border radius
- **Performant**: Simple positioned elements, no SVG
- **Scalable**: Works at any size (24pt to 40pt+)
- **Theme-aware**: Uses `theme.colors.accentGraphic` consistently

---

## 🎬 Animation

All animations preserved and enhanced:
- **Reanimated-based**: Smooth, performant motion
- **Reduced motion support**: Animations disabled when user prefers less motion
- **Physics-based**: Spring configs for natural movement
  - Rope drop (splash)
  - Carabiner clip-in (splash, notifications)  
  - Rope take-in (setup flow)

---

## 📊 Impact

### Components Updated
- `ui/carabiner.tsx` — One carabiner definition, used everywhere
- `connect/rope-splash.tsx` — Splash screen curved rope
- `connect/rope-pull.tsx` — Setup flow straight rope
- `connect/brand.tsx` — Brand animation rope segments
- `ui/notification-carabiner.tsx` — Notification rope segment

### Code Quality
- ✅ TypeScript strict mode passes
- ✅ Theme colors used consistently (no hardcoded values after fix)
- ✅ Reduced motion respected throughout
- ✅ Accessibility attributes preserved
- ✅ No breaking changes to component APIs

### Visual Consistency
- All ropes use same 4-layer technique
- All carabiners render from single definition
- Brand blue (`accentGraphic`) used everywhere
- Dark Ledger style maintained

---

## 🎯 Design Goals Achieved

✅ **Rope looks like actual climbing rope** — twisted strands, thickness, continuous curve  
✅ **Carabiner looks like real metal hardware** — D-shape, gate, 3D depth  
✅ **Animations work with physics** — drop, pull/take-in, clip under load  
✅ **Dark Ledger style preserved** — blue accent, premium near-black  
✅ **Reduced motion respected** — all animations gate on preference  
✅ **No disconnected line segments** — brand animation uses layered approach  

---

## 📐 Technical Specs

### Carabiner Dimensions
- Width: `size` (default 40pt)
- Height: `size × 1.3` (default 52pt)
- Stroke: 3pt (customizable)
- Gate: stroke + 1.5pt
- Spine radius: 55% of width (left side)
- Gate radius: 32% of width (right side)

### Rope Dimensions
- **Splash**: 6pt thickness, 4 layers
- **Pull**: 5pt width, 4 layers  
- **Brand segments**: 5pt width, 10pt height, 4 layers each
- **Notification**: 4pt width, 4 layers

### Layer Opacities
- Shadows: 15-20% black
- Main body: 100% accent color
- Primary highlight: 35% white
- Secondary highlight: 15% white
- Dark strand (splash only): ~80% accent color

---

This creates **authentic climbing gear visuals** that match Belay's brand promise: hold the line.
