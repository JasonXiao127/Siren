import { useState, useEffect } from 'react';
import { Music } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ArtworkProps {
  src: string | null;
  alt: string;
  className?: string;
  iconClassName?: string;
  /**
   * How the image should fit within its container.
   * - 'cover': fills the box, cropping overflow (good for square album art)
   * - 'contain': fits the whole image, letterboxing with the background (good for 16:9 thumbnails)
   */
  objectFit?: 'cover' | 'contain';
  /**
   * How to fill empty space when the image doesn't match the box.
   * - 'none': current behavior (image alone, bars show through)
   * - 'matte': uniform `bg-secondary` behind a `contain` image (cheap, good for 40px rows)
   * - 'blur': same image reused blurred behind a sharp `contain` foreground
   *   (no crop, no black bars, good for large cards; no extra data needed)
   */
  fill?: 'none' | 'matte' | 'blur';
  /**
   * How the container should size itself relative to the image.
   * - 'square': fixed square box (default, backward compatible)
   * - 'video': fixed 16:9 box
   * - 'auto': adapts to the image's natural aspect ratio (clamped 1:1 to 16:9)
   */
  aspectRatio?: 'auto' | 'square' | 'video';
}

export function Artwork({
  src,
  alt,
  className,
  iconClassName,
  objectFit = 'cover',
  aspectRatio = 'square',
  fill = 'none',
}: ArtworkProps) {
  const [error, setError] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null);

  // Reset the error state when the src changes (e.g. navigating between tracks)
  useEffect(() => {
    setError(false);
    setNaturalRatio(null);
  }, [src]);

  // Placeholder (no src or error)
  if (!src || error) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-gradient-to-br from-secondary to-muted',
          aspectRatio === 'video' && 'aspect-video',
          aspectRatio === 'auto' && 'aspect-square',
          className
        )}
      >
        <Music className={cn('h-8 w-8 text-muted-foreground', iconClassName)} />
      </div>
    );
  }

  // Blurred fill: uniform box, full image kept sharp on top, same image
  // blurred behind to fill the bars. No crop, no extra network data.
  if (fill === 'blur') {
    return (
      <div className={cn('relative overflow-hidden bg-secondary', className)}>
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-xl"
          onError={() => setError(true)}
          loading="lazy"
        />
        <img
          src={src}
          alt={alt}
          className="relative h-full w-full object-contain"
          onError={() => setError(true)}
          loading="lazy"
        />
      </div>
    );
  }

  // Matte fill: uniform box with an intentional background behind `contain`.
  // Cheap (single decode) — for small list thumbs.
  if (fill === 'matte') {
    return (
      <div
        className={cn(
          'flex items-center justify-center overflow-hidden bg-secondary/60',
          className
        )}
      >
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-contain"
          onError={() => setError(true)}
          loading="lazy"
        />
      </div>
    );
  }

  // Auto aspect ratio: wrap in a container that adapts to the image's natural dimensions
  if (aspectRatio === 'auto') {
    return (
      <div
        className={cn('overflow-hidden', className)}
        style={{ aspectRatio: naturalRatio ? `${naturalRatio}` : '1 / 1' }}
      >
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-contain"
          onError={() => setError(true)}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              // Clamp between 1:1 and 16:9 to avoid extreme ratios
              const ratio = Math.min(Math.max(naturalWidth / naturalHeight, 1), 16 / 9);
              setNaturalRatio(ratio);
            }
          }}
          loading="lazy"
        />
      </div>
    );
  }

  // Square or video: direct img with fixed aspect
  return (
    <img
      src={src}
      alt={alt}
      className={cn(
        objectFit === 'contain' ? 'object-contain' : 'object-cover',
        aspectRatio === 'video' && 'aspect-video',
        className
      )}
      onError={() => setError(true)}
      loading="lazy"
    />
  );
}