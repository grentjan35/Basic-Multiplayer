#!/usr/bin/env python3
"""
Compress PNG sprites to reduce file size for base64 WebSocket transmission.
Keeps original dimensions but reduces color depth and optimizes compression.
"""
import os
from PIL import Image

ASSETS_DIR = os.path.join(os.path.dirname(__file__), 'assets')

# New sprites that need compression (these are >1MB raw)
NEW_SPRITES = [
  
]

def compress_png(filepath):
    """Resize (if needed), compress, and optimize a PNG sprite."""
    filename = os.path.basename(filepath)
    original_size = os.path.getsize(filepath)
    print(f"\nProcessing: {filename} ({original_size/1024:.1f} KB)")
    
    img = Image.open(filepath).convert('RGBA')
    
    # Check dimensions - original sprites are 256x256
    orig_w, orig_h = img.size
    target_size = 256
    
    if orig_w != target_size or orig_h != target_size:
        # Use Lanczos resampling for high-quality downscale
        img = img.resize((target_size, target_size), Image.Resampling.LANCZOS)
        print(f"  Resized: {orig_w}x{orig_h} -> {target_size}x{target_size}")
    
    # Separate alpha channel
    r, g, b, a = img.split()
    rgb_img = Image.merge('RGB', (r, g, b))
    
    # Quantize to 256 colors
    quantized = rgb_img.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    
    # Convert back to RGBA with original alpha
    quantized_rgba = quantized.convert('RGBA')
    r2, g2, b2, _ = quantized_rgba.split()
    final = Image.merge('RGBA', (r2, g2, b2, a))
    
    # Save with maximum PNG compression
    final.save(filepath, 'PNG', optimize=True)
    
    new_size = os.path.getsize(filepath)
    pct = (1 - new_size / original_size) * 100
    print(f"  Result: {new_size/1024:.1f} KB ({pct:.1f}% reduction)")
    return new_size < original_size

def main():
    print("=== PNG Sprite Compressor ===")
    print(f"Assets directory: {ASSETS_DIR}")
    
    if not os.path.isdir(ASSETS_DIR):
        print(f"ERROR: Assets directory not found at {ASSETS_DIR}")
        return
    
    total_original = 0
    total_compressed = 0
    success_count = 0
    
    for filename in NEW_SPRITES:
        filepath = os.path.join(ASSETS_DIR, filename)
        if os.path.exists(filepath):
            total_original += os.path.getsize(filepath)
            if compress_png(filepath):
                total_compressed += os.path.getsize(filepath)
                success_count += 1
        else:
            print(f"  SKIP: {filename} not found")
    
    print(f"\n=== Summary ===")
    print(f"Processed: {success_count}/{len(NEW_SPRITES)} files")
    if success_count > 0:
        reduction = (1 - total_compressed / total_original) * 100
        print(f"Total: {total_original/1024:.1f} KB -> {total_compressed/1024:.1f} KB ({reduction:.1f}% reduction)")

if __name__ == '__main__':
    main()