/**
 * Quake III's adaptive Huffman coder.
 * Ported from Quake III Arena's code/qcommon/huffman.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every byte of a `.dm_68` demo past the per-message header is Huffman-coded,
 * so nothing else in `src/demo/` can read anything until this is exactly
 * right. A single wrong entry in `MSG_HDATA` (`msg.ts`) or one misordered
 * branch here corrupts the stream from the first symbol on, and the failure
 * looks like a plausible-but-wrong message type rather than like a decode
 * error -- which is why this is ported line for line rather than replaced
 * with a table-driven decoder that would be faster and unverifiable.
 *
 * ## The tree does not adapt while a message is coded
 *
 * This is the one thing about Q3's use of it that is easy to get backwards,
 * and getting it backwards produces a decoder that reads the first few dozen
 * bytes correctly and then drifts. `Huff_addRef` -- the adaptive half, the
 * part that reweights and reorders the tree -- is called ONLY from
 * `MSG_initHuffman`, 256 symbols x their `msg_hData` frequency, once. From
 * then on `MSG_ReadBits`/`MSG_WriteBits` call `Huff_offsetReceive` /
 * `Huff_offsetTransmit`, neither of which touches a weight. The algorithm is
 * adaptive; Quake uses it to build one fixed tree from a hardcoded frequency
 * table and then freezes it.
 *
 * `addRef` and `increment` are ported in full anyway, because they are what
 * builds that tree and the tree is only correct if they are.
 *
 * ## `node_t **head`
 *
 * C's `head` is a pointer to a pointer -- a *shared slot* naming the highest
 * ranked node in a weight block, so that several nodes can point at one slot
 * and all see it change at once. `PtrSlot` is that indirection made explicit;
 * `*node->head = x` reads as `node.head.node = x`. The pool
 * (`nodePtrs`/`blocPtrs`) and its freelist are a LIFO stack here, which is
 * what C's threaded freelist is too.
 *
 * `bloc`, the file-static bit cursor, becomes an explicit `BitCursor` rather
 * than module state: two demos decoding at once is a thing a library can be
 * asked to do and a shared global would silently interleave them.
 */

/** `HMAX` -- the maximum symbol. */
const HMAX = 256;

/** `NYT` -- not yet transmitted. */
const NYT = HMAX;

const INTERNAL_NODE = HMAX + 1;

interface HuffNode {
  left: HuffNode | null;
  right: HuffNode | null;
  parent: HuffNode | null;
  next: HuffNode | null;
  prev: HuffNode | null;
  /** `node_t **head` -- see the file header. */
  head: PtrSlot | null;
  weight: number;
  symbol: number;
}

/** One `node_t *` cell out of `nodePtrs[]`, addressable by several nodes. */
interface PtrSlot {
  node: HuffNode | null;
}

/** A bit position within a byte buffer. C's file-static `bloc`. */
export interface BitCursor {
  bloc: number;
}

function newNode(): HuffNode {
  return {
    left: null,
    right: null,
    parent: null,
    next: null,
    prev: null,
    head: null,
    weight: 0,
    symbol: 0,
  };
}

/** `Huff_putBit`. */
export function huffPutBit(bit: number, fout: Uint8Array, cursor: BitCursor): void {
  let bloc = cursor.bloc;
  if ((bloc & 7) === 0) {
    fout[bloc >> 3] = 0;
  }
  fout[bloc >> 3] |= bit << (bloc & 7);
  bloc++;
  cursor.bloc = bloc;
}

/** `Huff_getBit`. */
export function huffGetBit(fin: Uint8Array, cursor: BitCursor): number {
  const bloc = cursor.bloc;
  const t = (fin[bloc >> 3] >> (bloc & 7)) & 0x1;
  cursor.bloc = bloc + 1;
  return t;
}

/** `huff_t`. */
export class HuffTree {
  tree: HuffNode | null = null;
  private lhead: HuffNode | null = null;
  private ltail: HuffNode | null = null;
  /** `loc[HMAX+1]`. */
  private readonly loc: (HuffNode | null)[] = new Array<HuffNode | null>(HMAX + 1).fill(null);
  private readonly freelist: PtrSlot[] = [];

  constructor() {
    // `Huff_Init`: the tree and the list both start as the single NYT node.
    const node = newNode();
    node.symbol = NYT;
    node.weight = 0;
    node.next = null;
    node.prev = null;
    node.parent = null;
    node.left = null;
    node.right = null;
    this.tree = node;
    this.lhead = node;
    this.ltail = node;
    this.loc[NYT] = node;
  }

  /** `get_ppnode`. */
  private getPpnode(): PtrSlot {
    const slot = this.freelist.pop();
    return slot ?? { node: null };
  }

  /** `free_ppnode`. */
  private freePpnode(slot: PtrSlot): void {
    this.freelist.push(slot);
  }

  /** `swap` -- exchange two nodes' places in the TREE. */
  private swap(node1: HuffNode, node2: HuffNode): void {
    const par1 = node1.parent;
    const par2 = node2.parent;

    if (par1) {
      if (par1.left === node1) {
        par1.left = node2;
      } else {
        par1.right = node2;
      }
    } else {
      this.tree = node2;
    }

    if (par2) {
      if (par2.left === node2) {
        par2.left = node1;
      } else {
        par2.right = node1;
      }
    } else {
      this.tree = node1;
    }

    node1.parent = par2;
    node2.parent = par1;
  }

  /**
   * `Huff_addRef`. Adds one occurrence of `ch`, growing the tree the first
   * time a symbol is seen and reweighting it every time after.
   *
   * Called only while the tree is being built from `MSG_HDATA` -- see the
   * file header.
   */
  addRef(ch: number): void {
    const lhead = this.lhead;
    if (this.loc[ch] === null) {
      // First transmission of this symbol: split the NYT node into an
      // internal node with the old NYT on the left and the new symbol on the
      // right.
      if (!lhead) {
        return;
      }
      const tnode = newNode();
      const tnode2 = newNode();

      tnode2.symbol = INTERNAL_NODE;
      tnode2.weight = 1;
      tnode2.next = lhead.next;
      if (lhead.next) {
        lhead.next.prev = tnode2;
        if (lhead.next.weight === 1) {
          tnode2.head = lhead.next.head;
        } else {
          tnode2.head = this.getPpnode();
          tnode2.head.node = tnode2;
        }
      } else {
        tnode2.head = this.getPpnode();
        tnode2.head.node = tnode2;
      }
      lhead.next = tnode2;
      tnode2.prev = lhead;

      tnode.symbol = ch;
      tnode.weight = 1;
      tnode.next = lhead.next;
      if (lhead.next) {
        lhead.next.prev = tnode;
        if (lhead.next.weight === 1) {
          tnode.head = lhead.next.head;
        } else {
          /* this should never happen */
          tnode.head = this.getPpnode();
          tnode.head.node = tnode2;
        }
      } else {
        /* this should never happen */
        tnode.head = this.getPpnode();
        tnode.head.node = tnode;
      }
      lhead.next = tnode;
      tnode.prev = lhead;
      tnode.left = null;
      tnode.right = null;

      if (lhead.parent) {
        if (lhead.parent.left === lhead) {
          /* lhead is guaranteed to be the NYT */
          lhead.parent.left = tnode2;
        } else {
          lhead.parent.right = tnode2;
        }
      } else {
        this.tree = tnode2;
      }

      tnode2.right = tnode;
      tnode2.left = lhead;

      tnode2.parent = lhead.parent;
      lhead.parent = tnode2;
      tnode.parent = tnode2;

      this.loc[ch] = tnode;

      this.increment(tnode2.parent);
    } else {
      this.increment(this.loc[ch]);
    }
  }

  /** `increment`. */
  private increment(node: HuffNode | null): void {
    if (!node) {
      return;
    }

    if (node.next !== null && node.next.weight === node.weight) {
      const lnode = node.head?.node ?? null;
      if (lnode && lnode !== node.parent) {
        this.swap(lnode, node);
      }
      if (lnode) {
        swaplist(lnode, node);
      }
    }
    if (node.prev && node.prev.weight === node.weight) {
      if (node.head) {
        node.head.node = node.prev;
      }
    } else {
      if (node.head) {
        node.head.node = null;
        this.freePpnode(node.head);
      }
    }
    node.weight++;
    if (node.next && node.next.weight === node.weight) {
      node.head = node.next.head;
    } else {
      node.head = this.getPpnode();
      node.head.node = node;
    }
    if (node.parent) {
      this.increment(node.parent);
      if (node.prev === node.parent) {
        swaplist(node, node.parent);
        if (node.head?.node === node) {
          node.head.node = node.parent;
        }
      }
    }
  }

  /**
   * `send` -- write the prefix code for `node`, walking up to the root and
   * emitting on the way back down.
   */
  private send(node: HuffNode, child: HuffNode | null, fout: Uint8Array, cursor: BitCursor): void {
    if (node.parent) {
      this.send(node.parent, node, fout, cursor);
    }
    if (child) {
      huffPutBit(node.right === child ? 1 : 0, fout, cursor);
    }
  }

  /**
   * `Huff_offsetTransmit`. Note it calls `send` directly rather than
   * `Huff_transmit`: it never emits a NYT escape, because by the time
   * anything writes a message every symbol is already in the tree.
   */
  offsetTransmit(ch: number, fout: Uint8Array, cursor: BitCursor): void {
    const node = this.loc[ch];
    if (!node) {
      return;
    }
    this.send(node, null, fout, cursor);
  }

  /** The tail of the rank list. Unused by decode; kept because `Huff_Init`
   *  sets it and a reader comparing this file to the C would miss it. */
  get listTail(): HuffNode | null {
    return this.ltail;
  }
}

/** `swaplist` -- exchange two nodes' places in the doubly-linked rank list. */
function swaplist(node1: HuffNode, node2: HuffNode): void {
  let par1 = node1.next;
  node1.next = node2.next;
  node2.next = par1;

  par1 = node1.prev;
  node1.prev = node2.prev;
  node2.prev = par1;

  if (node1.next === node1) {
    node1.next = node2;
  }
  if (node2.next === node2) {
    node2.next = node1;
  }
  if (node1.next) {
    node1.next.prev = node1;
  }
  if (node2.next) {
    node2.next.prev = node2;
  }
  if (node1.prev) {
    node1.prev.next = node1;
  }
  if (node2.prev) {
    node2.prev.next = node2;
  }
}

/**
 * `Huff_offsetReceive`. Walks the tree one bit at a time from `node` until a
 * leaf, and returns its symbol.
 *
 * A null branch returns 0 rather than erroring, exactly as id's does (the
 * `Com_Error` is commented out there). A stream that reaches one is already
 * corrupt; the caller finds out from the message parse, not from here.
 */
export function huffOffsetReceive(
  node: HuffNode | null,
  fin: Uint8Array,
  cursor: BitCursor,
): number {
  let n = node;
  while (n && n.symbol === INTERNAL_NODE) {
    n = huffGetBit(fin, cursor) ? n.right : n.left;
  }
  if (!n) {
    return 0;
  }
  return n.symbol;
}

/** `huffman_t` -- the pair Quake keeps, one tree per direction. */
export class Huffman {
  readonly compressor = new HuffTree();
  readonly decompressor = new HuffTree();

  /** `MSG_initHuffman`: seed both trees from the hardcoded frequency table. */
  seed(hData: readonly number[]): void {
    for (let i = 0; i < 256; i++) {
      for (let j = 0; j < hData[i]; j++) {
        this.compressor.addRef(i);
        this.decompressor.addRef(i);
      }
    }
  }
}
