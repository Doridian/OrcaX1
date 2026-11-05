// Curated process settings shown in the sidebar (Orca's most-used options).
// The "All" tab lists every key of the preset as raw text.

export type Field =
  | { key: string; label: string; type: 'number'; unit?: string; step?: number; min?: number; max?: number }
  | { key: string; label: string; type: 'percent' }
  | { key: string; label: string; type: 'bool' }
  | { key: string; label: string; type: 'enum'; options: [string, string][] }
  | { key: string; label: string; type: 'text' }

export interface Group { title: string; fields: Field[] }
export interface Tab { id: string; title: string; groups: Group[] }

const INFILL: [string, string][] = [
  ['rectilinear', 'Rectilinear'], ['alignedrectilinear', 'Aligned rectilinear'], ['zigzag', 'Zig zag'],
  ['crosszag', 'Cross zag'], ['lockedzag', 'Locked zag'], ['line', 'Line'], ['grid', 'Grid'], ['triangles', 'Triangles'],
  ['tri-hexagon', 'Tri-hexagon'], ['cubic', 'Cubic'], ['adaptivecubic', 'Adaptive cubic'], ['quartercubic', 'Quarter cubic'],
  ['supportcubic', 'Support cubic'], ['lightning', 'Lightning'], ['honeycomb', 'Honeycomb'], ['3dhoneycomb', '3D honeycomb'],
  ['lateral-honeycomb', 'Lateral honeycomb'], ['lateral-lattice', 'Lateral lattice'], ['crosshatch', 'Cross hatch'],
  ['tpmsd', 'TPMS-D'], ['gyroid', 'Gyroid'], ['concentric', 'Concentric'], ['hilbertcurve', 'Hilbert curve'],
  ['archimedeanchords', 'Archimedean chords'], ['octagramspiral', 'Octagram spiral'],
]
const SURFACE: [string, string][] = [
  ['monotonic', 'Monotonic'], ['monotonicline', 'Monotonic line'], ['rectilinear', 'Rectilinear'],
  ['alignedrectilinear', 'Aligned rectilinear'], ['concentric', 'Concentric'], ['hilbertcurve', 'Hilbert curve'],
  ['archimedeanchords', 'Archimedean chords'], ['octagramspiral', 'Octagram spiral'],
]

export const TABS: Tab[] = [
  {
    id: 'quality', title: 'Quality', groups: [
      {
        title: 'Layer height', fields: [
          { key: 'layer_height', label: 'Layer height', type: 'number', unit: 'mm', step: 0.02, min: 0.04 },
          { key: 'initial_layer_print_height', label: 'First layer height', type: 'number', unit: 'mm', step: 0.02, min: 0.04 },
        ],
      },
      {
        title: 'Line width', fields: [
          { key: 'line_width', label: 'Default', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'outer_wall_line_width', label: 'Outer wall', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'initial_layer_line_width', label: 'First layer', type: 'number', unit: 'mm', step: 0.01 },
        ],
      },
      {
        title: 'Seam', fields: [
          { key: 'seam_position', label: 'Seam position', type: 'enum', options: [['nearest', 'Nearest'], ['aligned', 'Aligned'], ['aligned_back', 'Aligned back'], ['back', 'Back'], ['random', 'Random']] },
          { key: 'seam_gap', label: 'Seam gap', type: 'text' },
        ],
      },
      {
        title: 'Precision', fields: [
          { key: 'xy_hole_compensation', label: 'X-Y hole compensation', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'xy_contour_compensation', label: 'X-Y contour compensation', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'elefant_foot_compensation', label: 'Elephant foot compensation', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'enable_arc_fitting', label: 'Arc fitting', type: 'bool' },
        ],
      },
      {
        title: 'Ironing', fields: [
          { key: 'ironing_type', label: 'Ironing type', type: 'enum', options: [['no ironing', 'No ironing'], ['top', 'Top surfaces'], ['topmost', 'Topmost surface'], ['solid', 'All solid layers']] },
          { key: 'ironing_flow', label: 'Ironing flow', type: 'percent' },
          { key: 'ironing_spacing', label: 'Ironing spacing', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'ironing_speed', label: 'Ironing speed', type: 'number', unit: 'mm/s' },
        ],
      },
      {
        title: 'Walls', fields: [
          { key: 'wall_generator', label: 'Wall generator', type: 'enum', options: [['classic', 'Classic'], ['arachne', 'Arachne']] },
          { key: 'wall_infill_order', label: 'Order', type: 'enum', options: [['inner wall/outer wall/infill', 'Inner/Outer/Infill'], ['outer wall/inner wall/infill', 'Outer/Inner/Infill'], ['inner-outer-inner wall/infill', 'Inner-Outer-Inner/Infill'], ['infill/inner wall/outer wall', 'Infill/Inner/Outer'], ['infill/outer wall/inner wall', 'Infill/Outer/Inner']] },
          { key: 'detect_thin_wall', label: 'Detect thin walls', type: 'bool' },
          { key: 'only_one_wall_top', label: 'Only one wall on top surfaces', type: 'bool' },
        ],
      },
    ],
  },
  {
    id: 'strength', title: 'Strength', groups: [
      {
        title: 'Walls', fields: [
          { key: 'wall_loops', label: 'Wall loops', type: 'number', step: 1, min: 0 },
        ],
      },
      {
        title: 'Top/bottom shells', fields: [
          { key: 'top_surface_pattern', label: 'Top surface pattern', type: 'enum', options: SURFACE },
          { key: 'top_shell_layers', label: 'Top shell layers', type: 'number', step: 1, min: 0 },
          { key: 'top_shell_thickness', label: 'Top shell thickness', type: 'number', unit: 'mm', step: 0.1 },
          { key: 'bottom_surface_pattern', label: 'Bottom surface pattern', type: 'enum', options: SURFACE },
          { key: 'bottom_shell_layers', label: 'Bottom shell layers', type: 'number', step: 1, min: 0 },
          { key: 'bottom_shell_thickness', label: 'Bottom shell thickness', type: 'number', unit: 'mm', step: 0.1 },
        ],
      },
      {
        title: 'Infill', fields: [
          { key: 'sparse_infill_density', label: 'Sparse infill density', type: 'percent' },
          { key: 'sparse_infill_pattern', label: 'Sparse infill pattern', type: 'enum', options: INFILL },
          { key: 'infill_direction', label: 'Infill direction', type: 'number', unit: '°' },
          { key: 'infill_wall_overlap', label: 'Infill/wall overlap', type: 'percent' },
          { key: 'internal_solid_infill_pattern', label: 'Internal solid infill pattern', type: 'enum', options: SURFACE },
        ],
      },
    ],
  },
  {
    id: 'speed', title: 'Speed', groups: [
      {
        title: 'First layer', fields: [
          { key: 'initial_layer_speed', label: 'First layer', type: 'number', unit: 'mm/s' },
          { key: 'initial_layer_infill_speed', label: 'First layer infill', type: 'number', unit: 'mm/s' },
        ],
      },
      {
        title: 'Other layers', fields: [
          { key: 'outer_wall_speed', label: 'Outer wall', type: 'number', unit: 'mm/s' },
          { key: 'inner_wall_speed', label: 'Inner wall', type: 'number', unit: 'mm/s' },
          { key: 'sparse_infill_speed', label: 'Sparse infill', type: 'number', unit: 'mm/s' },
          { key: 'internal_solid_infill_speed', label: 'Internal solid infill', type: 'number', unit: 'mm/s' },
          { key: 'top_surface_speed', label: 'Top surface', type: 'number', unit: 'mm/s' },
          { key: 'gap_infill_speed', label: 'Gap infill', type: 'number', unit: 'mm/s' },
          { key: 'bridge_speed', label: 'Bridge', type: 'number', unit: 'mm/s' },
          { key: 'support_speed', label: 'Support', type: 'number', unit: 'mm/s' },
          { key: 'travel_speed', label: 'Travel', type: 'number', unit: 'mm/s' },
        ],
      },
      {
        title: 'Acceleration', fields: [
          { key: 'default_acceleration', label: 'Normal printing', type: 'number', unit: 'mm/s²' },
          { key: 'outer_wall_acceleration', label: 'Outer wall', type: 'number', unit: 'mm/s²' },
          { key: 'travel_acceleration', label: 'Travel', type: 'number', unit: 'mm/s²' },
          { key: 'initial_layer_acceleration', label: 'First layer', type: 'number', unit: 'mm/s²' },
        ],
      },
    ],
  },
  {
    id: 'support', title: 'Support', groups: [
      {
        title: 'Support', fields: [
          { key: 'enable_support', label: 'Enable support', type: 'bool' },
          { key: 'support_type', label: 'Type', type: 'enum', options: [['normal(auto)', 'Normal (auto)'], ['tree(auto)', 'Tree (auto)'], ['normal(manual)', 'Normal (manual)'], ['tree(manual)', 'Tree (manual)']] },
          { key: 'support_style', label: 'Style', type: 'enum', options: [['default', 'Default'], ['grid', 'Grid'], ['snug', 'Snug'], ['organic', 'Organic'], ['tree_slim', 'Tree slim'], ['tree_strong', 'Tree strong'], ['tree_hybrid', 'Tree hybrid']] },
          { key: 'support_threshold_angle', label: 'Threshold angle', type: 'number', unit: '°' },
          { key: 'support_on_build_plate_only', label: 'On build plate only', type: 'bool' },
          { key: 'support_top_z_distance', label: 'Top Z distance', type: 'number', unit: 'mm', step: 0.01 },
          { key: 'support_interface_top_layers', label: 'Top interface layers', type: 'number', step: 1 },
          { key: 'raft_layers', label: 'Raft layers', type: 'number', step: 1, min: 0 },
        ],
      },
    ],
  },
  {
    id: 'others', title: 'Others', groups: [
      {
        title: 'Bed adhesion', fields: [
          { key: 'skirt_loops', label: 'Skirt loops', type: 'number', step: 1, min: 0 },
          { key: 'brim_type', label: 'Brim type', type: 'enum', options: [['auto_brim', 'Auto'], ['brim_ears', 'Mouse ear'], ['outer_only', 'Outer only'], ['inner_only', 'Inner only'], ['outer_and_inner', 'Outer and inner'], ['no_brim', 'No brim']] },
          { key: 'brim_width', label: 'Brim width', type: 'number', unit: 'mm' },
          { key: 'brim_object_gap', label: 'Brim-object gap', type: 'number', unit: 'mm', step: 0.05 },
        ],
      },
      {
        title: 'Prime tower', fields: [
          { key: 'enable_prime_tower', label: 'Enable', type: 'bool' },
          { key: 'prime_tower_width', label: 'Width', type: 'number', unit: 'mm' },
        ],
      },
      {
        title: 'Special mode', fields: [
          { key: 'print_sequence', label: 'Print sequence', type: 'enum', options: [['by layer', 'By layer'], ['by object', 'By object']] },
          { key: 'spiral_mode', label: 'Spiral vase', type: 'bool' },
          { key: 'timelapse_type', label: 'Timelapse', type: 'enum', options: [['0', 'Traditional'], ['1', 'Smooth']] },
          { key: 'fuzzy_skin', label: 'Fuzzy skin', type: 'enum', options: [['none', 'None'], ['external', 'Outer walls'], ['all', 'All walls'], ['allwalls', 'All walls (incl. inner)']] },
        ],
      },
    ],
  },
]
