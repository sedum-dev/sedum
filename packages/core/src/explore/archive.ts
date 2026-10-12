import { pickWeighted, type SeededRandom } from "./random.js";
import type { ExploreAction } from "./types.js";

/**
 * Go-explore without snapshots: remember how each kind of page was first
 * reached, then return there by replaying that path and explore onwards.
 * Antithesis branches from interesting states with a hypervisor; Sedum's
 * traces replay deterministically, which is enough for a web app.
 */
export interface Cell {
  readonly key: string;
  /** Actions from the start page; never one that wrote to the server. */
  path: readonly ExploreAction[];
  visits: number;
  returns: number;
  /** Targets on this page the walk has not tried yet. */
  untried: number;
}

export interface ArchiveOptions {
  /** Return to a frontier cell after this many steps without a new cell. */
  readonly staleAfter: number;
  /** Paths longer than this are not worth replaying. */
  readonly maxPath: number;
}

/** A route with record ids and query folded, e.g. /clients/:id. */
export function routeTemplate(route: string): string {
  return route
    .split("?")[0]!
    .split("/")
    .map((part) =>
      /^\d+$|[0-9a-f]{8}-[0-9a-f-]{27}/iu.test(part) ? ":id" : part,
    )
    .join("/");
}

function shorter(cell: Cell, path: readonly ExploreAction[]): boolean {
  return !cell.path.length || path.length < cell.path.length;
}

export const DEFAULT_ARCHIVE: ArchiveOptions = { staleAfter: 30, maxPath: 40 };

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
  visit(key: string, path: readonly ExploreAction[], clean: boolean): void {
    const cell = this.#cells.get(key);
    const usable = clean && path.length <= this.options.maxPath;
    if (!cell) {
      this.#cells.set(key, {
        key,
        path: usable ? [...path] : [],
        visits: 1,
        returns: 0,
        untried: 0,
      });
      if (usable) this.#sinceNew = 0;
      return;
    }
    cell.visits++;
    this.#sinceNew++;
    if (usable && shorter(cell, path)) cell.path = [...path];
  }

  untried(key: string, count: number): void {
    const cell = this.#cells.get(key);
    if (cell) cell.untried = count;
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
      (c) => c.key !== current && c.path.length > 0 && c.untried > 0,
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
