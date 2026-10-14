import { pickWeighted, type SeededRandom } from "./random.js";
import type { ExploreAction } from "./types.js";

/**
 * Go-explore without snapshots: remember each kind of page and how it was
 * reached, then return there and explore onwards. A web app usually only
 * needs the page's URL to restore a state, and a recorded path when the URL
 * alone does not restore it.
 */
export interface Cell {
  readonly key: string;
  /** The page's URL when first seen; loading it is the cheapest return. */
  readonly url: string;
  /** False once loading the URL landed on another kind of page. */
  direct: boolean;
  /** A clean path that reached the cell: never one that wrote to the server. */
  path?: Episode;
  visits: number;
  returns: number;
  /** Targets on this page the walk has not tried yet. */
  untried: number;
}

/** Actions since the walk last loaded a URL. */
export interface Episode {
  readonly start: string;
  readonly actions: readonly ExploreAction[];
}

/** One observation of a cell: where the walk is and how it got there. */
export interface Visit {
  readonly key: string;
  readonly url: string;
  readonly episode: Episode;
  /** No action in the episode wrote to the server. */
  readonly clean: boolean;
}

export interface ArchiveOptions {
  /** Return to a frontier cell after this many steps without a new cell. */
  readonly staleAfter: number;
  /** Paths longer than this are not worth replaying. */
  readonly maxPath: number;
}

/** Numbers, UUIDs, ULIDs and other long tokens that mix letters and digits. */
const RECORD_ID =
  /^\d+$|[0-9a-f]{8}-[0-9a-f-]{27}|^[0-9A-HJKMNP-TV-Z]{26}$|^(?=.*\d)[\w-]{16,}$/iu;

/** A route with record ids and query folded, e.g. /customers/:id. */
export function routeTemplate(route: string): string {
  return route
    .split("?")[0]!
    .split("/")
    .map((part) => (RECORD_ID.test(part) ? ":id" : part))
    .join("/");
}

function shorter(cell: Cell, episode: Episode): boolean {
  return !cell.path || episode.actions.length < cell.path.actions.length;
}

/** How to get back to a cell: load its URL, or replay its path. */
export function returnPath(cell: Cell): ExploreAction[] {
  if (cell.direct || !cell.path) return [{ kind: "goto", url: cell.url }];
  return [{ kind: "goto", url: cell.path.start }, ...cell.path.actions];
}

export const DEFAULT_ARCHIVE: ArchiveOptions = { staleAfter: 30, maxPath: 15 };

export class Archive {
  readonly #cells = new Map<string, Cell>();
  #sinceNew = 0;

  constructor(private readonly options: ArchiveOptions = DEFAULT_ARCHIVE) {}

  get size(): number {
    return this.#cells.size;
  }

  /**
   * Note a visit. A new cell, or a shorter clean path to a known one, is
   * kept; a path that wrote to the server is never kept, so returning never
   * repeats a create or a save.
   */
  visit({ key, url, episode, clean }: Visit): void {
    const usable = clean && episode.actions.length <= this.options.maxPath;
    const cell = this.#cells.get(key);
    if (!cell) {
      this.#cells.set(key, {
        key,
        url,
        direct: true,
        ...(usable ? { path: copy(episode) } : {}),
        visits: 1,
        returns: 0,
        untried: 0,
      });
      this.#sinceNew = 0;
      return;
    }
    cell.visits++;
    this.#sinceNew++;
    if (usable && shorter(cell, episode)) cell.path = copy(episode);
  }

  untried(key: string, count: number): void {
    const cell = this.#cells.get(key);
    if (cell) cell.untried = count;
  }

  /** A return ended on `landed`: a direct load that missed is not tried again. */
  arrived(cell: Cell, landed: string): void {
    if (landed !== cell.key && cell.direct) cell.direct = false;
  }

  /** Time to return to a frontier: the walk has stopped finding new cells. */
  due(): boolean {
    return this.#sinceNew >= this.options.staleAfter;
  }

  /**
   * A cell to return to: rarely visited and with untried targets left,
   * weighted, so the walk still varies where it goes.
   */
  pick(random: SeededRandom, current: string): Cell | undefined {
    this.#sinceNew = 0;
    const options = [...this.#cells.values()].filter(
      (c) => c.key !== current && c.untried > 0 && (c.direct || c.path),
    );
    if (!options.length) return undefined;
    const weights = options.map(
      (c) => (1 + c.untried) / (1 + c.visits + 3 * c.returns),
    );
    const cell = options[pickWeighted(random, weights)]!;
    cell.returns++;
    return cell;
  }
}

function copy(episode: Episode): Episode {
  return { start: episode.start, actions: [...episode.actions] };
}
