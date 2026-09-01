// Phone-to-session image drop: photos the user picks on the iPhone, delivered
// into a Claude session's project the same way a screen recording is.
//
// This is the mirror image of recording.ts. There, the pixels already live on
// this machine and only counters cross the network; here the pixels start on
// the phone and MUST cross, so this module's job is to be a careful receiver:
// bytes are staged in memory (never on disk) until the user commits them to a
// session, every file's type is decided by sniffing its own bytes — a client
// label or filename is never consulted, let alone trusted — and delivery
// reuses the recorder's confinement check and disk lifecycle, because a
// second write surface must not mean a second, subtly different sandbox.
//
// One batch at a time, machine-wide, for the recorder's reason: the host has
// one user, and the batch's whole life is a few seconds between picking and
// sending. A batch nobody sends expires on its own so an abandoned upload
// cannot squat on memory or ride along inside next week's send.

import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isDenied, isInsideRoots } from './files.js';
import { pruneRecordings } from './recording.js';
import { frameName, timestampDirName } from './recording-frames.js';

/** How an image batch bounds itself. Every number is a hard cap. */
export const IMAGES = Object.freeze({
  /** Photos per send. Enough for a before/after pair with context to spare. */
  maxImages: 4,
  /** Per-image byte ceiling. A phone JPEG is single-digit MB; 12 covers HEIC originals. */
  maxImageBytes: 12 * 1024 * 1024,
  /** Whole-batch ceiling, so four maximal images cannot compound. */
  maxTotalBytes: 30 * 1024 * 1024,
  /** Image drops kept per project; older ones are deleted on each delivery. */
  maxSaved: 5,
  /** A staged batch nobody sends is dropped after this. */
  staleAfterMs: 10 * 60 * 1000,
} as const);

/**
 * The formats accepted, decided by magic bytes alone. SVG is deliberately
 * absent — it is a script container, and files-raw.ts already documents why a
 * mislabeled scriptable type is the failure mode to design against. Writing
 * runs the same risk in reverse: the extension we mint here is what every
 * later reader (Claude, the Files tab, a browser) will believe.
 */
export type ImageType = 'jpg' | 'png' | 'gif' | 'webp' | 'heic';

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1']);

/** Identify an image purely from its leading bytes, or null for anything else. */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'webp';
  if (
    bytes.subarray(4, 8).toString('latin1') === 'ftyp' &&
    HEIC_BRANDS.has(bytes.subarray(8, 12).toString('latin1'))
  ) return 'heic';
  return null;
}

export const IMAGE_DIR_PATTERN = /^img-\d{8}-\d{6}$/;

export interface ImageDropStatus {
  readonly images: number;
  readonly bytes: number;
}

export interface ImageDelivery {
  readonly dir: string;
  readonly relDir: string;
  readonly files: readonly string[];
  readonly prompt: string;
}

interface StagedImage {
  readonly bytes: Buffer;
  readonly type: ImageType;
}

/**
 * The prompt handed to Claude alongside the photos. Same skeleton as the
 * recording's: where the files are (relative, inside the session's own
 * project), what order to read them in, the user's note where the task goes,
 * and the reminder not to commit capture debris.
 */
export function buildImagesPrompt(args: {
  readonly relDir: string;
  readonly fileNames: readonly string[];
  readonly note?: string;
}): string {
  const { relDir, fileNames, note } = args;
  const count = fileNames.length;
  const ask = note?.trim()
    ? note.trim()
    : 'describe what each photo shows and how it relates to what we are working on.';
  return [
    `I'm sending ${count} photo${count === 1 ? '' : 's'} from my phone, in the order I picked them, in ${relDir}/ inside this project.`,
    `Look at ${count === 1 ? 'it' : 'each one in order'} (${fileNames.join(', ')}), then: ${ask}`,
    'The files are throwaway upload files — do not commit them.',
  ].join('\n\n');
}

export interface ImageDropOptions {
  readonly maxImages?: number;
  readonly maxImageBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSaved?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

/**
 * Staging + delivery for one batch of phone images. State machine is the
 * recorder's tail without its capture loop: empty → staged → (delivered |
 * discarded | expired). `deliver` re-checks confinement exactly as
 * Recorder.deliver does — a write primitive must not trust that some other
 * module's invariant still holds.
 */
export class ImageDrop {
  private readonly maxImages: number;
  private readonly maxImageBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxSaved: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  private staged: StagedImage[] = [];
  private startedAt = 0;

  constructor(options: ImageDropOptions = {}) {
    this.maxImages = options.maxImages ?? IMAGES.maxImages;
    this.maxImageBytes = options.maxImageBytes ?? IMAGES.maxImageBytes;
    this.maxTotalBytes = options.maxTotalBytes ?? IMAGES.maxTotalBytes;
    this.maxSaved = options.maxSaved ?? IMAGES.maxSaved;
    this.staleAfterMs = options.staleAfterMs ?? IMAGES.staleAfterMs;
    this.now = options.now ?? Date.now;
  }

  status(): ImageDropStatus {
    this.expireIfStale();
    return {
      images: this.staged.length,
      bytes: this.staged.reduce((sum, image) => sum + image.bytes.length, 0),
    };
  }

  /** Stage one image. Throws a phone-safe message when any cap or the type gate refuses it. */
  add(bytes: Buffer): ImageDropStatus {
    this.expireIfStale();
    if (bytes.length === 0) throw new Error('the image arrived empty');
    if (bytes.length > this.maxImageBytes) {
      throw new Error(`that image is too large (over ${Math.round(this.maxImageBytes / (1024 * 1024))} MB)`);
    }
    const type = sniffImageType(bytes);
    if (type === null) throw new Error('that file is not a supported image (JPEG, PNG, GIF, WebP or HEIC)');
    if (this.staged.length >= this.maxImages) {
      throw new Error(`at most ${this.maxImages} images can be sent at once`);
    }
    const total = this.staged.reduce((sum, image) => sum + image.bytes.length, 0);
    if (total + bytes.length > this.maxTotalBytes) {
      throw new Error('the images together are too large to send at once');
    }
    if (this.staged.length === 0) this.startedAt = this.now();
    this.staged = [...this.staged, { bytes, type }];
    return this.status();
  }

  discard(): ImageDropStatus {
    this.staged = [];
    this.startedAt = 0;
    return this.status();
  }

  /**
   * Write the staged images into `cwd` (a Claude session's project folder)
   * and build the prompt that references them. Names are minted here —
   * `photo-01.jpg` onward, extension from each image's sniffed type — so no
   * client-supplied string ever becomes part of a path.
   */
  async deliver(cwd: string, note?: string): Promise<ImageDelivery> {
    this.expireIfStale();
    if (this.staged.length === 0) throw new Error('there are no images to send');

    const realCwd = await realpath(cwd);
    if (!isInsideRoots(realCwd) || isDenied(realCwd)) {
      throw new Error('that project folder is outside the allowed folders');
    }

    const batch = this.staged;
    const dirName = timestampDirName(this.startedAt, 'img');
    const relDir = join('.belay', 'images', dirName);
    const imagesDir = join(realCwd, '.belay', 'images');
    const dir = join(imagesDir, dirName);
    await mkdir(dir, { recursive: true });

    const names = batch.map((image, i) => frameName(i, batch.length, 'photo', image.type));
    await Promise.all(batch.map((image, i) => writeFile(join(dir, names[i]), image.bytes)));

    await pruneRecordings(imagesDir, this.maxSaved, IMAGE_DIR_PATTERN);

    const prompt = buildImagesPrompt({ relDir, fileNames: names, note });
    this.discard();
    return { dir, relDir, files: names, prompt };
  }

  private expireIfStale(): void {
    if (this.staged.length > 0 && this.now() - this.startedAt >= this.staleAfterMs) {
      this.staged = [];
      this.startedAt = 0;
    }
  }
}

export const imageDrop = new ImageDrop();
