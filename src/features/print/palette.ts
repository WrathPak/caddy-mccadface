/** Filament colors: eight slots (like an AMS), each set to one color of a named palette. */

export const SLOT_COUNT = 8

export interface FilamentColor { id: string; label: string; hex: string }

export const FILAMENT_COLORS: FilamentColor[] = [
  { id: 'white', label: 'White', hex: '#f4f4f1' },
  { id: 'black', label: 'Black', hex: '#1c1c1e' },
  { id: 'gray', label: 'Gray', hex: '#8a8d92' },
  { id: 'red', label: 'Red', hex: '#d63a31' },
  { id: 'orange', label: 'Orange', hex: '#f08a24' },
  { id: 'yellow', label: 'Yellow', hex: '#f2cf2e' },
  { id: 'lime', label: 'Lime', hex: '#9ccc3a' },
  { id: 'green', label: 'Green', hex: '#2f9e55' },
  { id: 'teal', label: 'Teal', hex: '#1fa3a0' },
  { id: 'blue', label: 'Blue', hex: '#2f6fd1' },
  { id: 'navy', label: 'Navy', hex: '#1f3a78' },
  { id: 'purple', label: 'Purple', hex: '#7b4fc4' },
  { id: 'pink', label: 'Pink', hex: '#e86aa6' },
  { id: 'brown', label: 'Brown', hex: '#7a5232' },
  { id: 'beige', label: 'Beige', hex: '#d8c6a5' },
  { id: 'clear', label: 'Clear', hex: '#cfe4ee' },
]

export const DEFAULT_SLOT_COLORS = ['white', 'black', 'red', 'blue', 'green', 'yellow', 'orange', 'purple']

export const colorById = (id: string): FilamentColor => FILAMENT_COLORS.find((c) => c.id === id) ?? FILAMENT_COLORS[0]
