/**
 * `.arkprofile` codec — ARK: Survival Ascended player profile save files.
 *
 * These are Unreal property-tree saves with an ARK-specific container. Nothing
 * about the format is documented, so this was derived by disassembling real
 * profiles; the guarantee that keeps it honest is `parse → serialize` being
 * byte-identical for a file we did not write (see arkprofile.test.ts).
 *
 * That round-trip is the whole design constraint. Every leaf value is kept as
 * the exact bytes it occupied on disk rather than being decoded into a number
 * or a string, so anything this codec does not understand still survives a
 * rewrite untouched. Callers reach values through the typed accessors at the
 * bottom of this file, and edits only ever replace one leaf's bytes — sizes
 * and file offsets are recomputed on write.
 *
 * Two save versions are in the wild and both are supported. Version 5 is the
 * original ASA layout; version 7 arrived with the Unreal 5.5 upgrade (Lost
 * Colony / Gen 1) and rewrites how every property is tagged. A profile is
 * always written back in the version it was read as — the game will not read a
 * v5 file on a v7 map or the reverse.
 *
 * Container layout:
 *
 *   int32   saveVersion            5 or 7
 *   int32   unrealVersion4         v7 only (522 = UE4 file version)
 *   int32   unrealVersion5         v7 only (1013 = UE5 file version)
 *   int32   objectCount
 *   object[objectCount]:
 *     byte[16] guid
 *     FString  className          e.g. "/Game/…/PrimalPlayerDataBP.…_C"
 *     int32    isItem
 *     int32    nameCount
 *     FString  names[nameCount]   instance name, game mode, level, map, map path
 *     int32    unknown x3         zero in every profile seen
 *     int64    propertiesOffset   absolute, into this file
 *   …then each object's body, in table order, at its recorded offset:
 *     uint8    leading byte       v7 only
 *     property list terminated by the FString "None"
 *     int32    objectRefCount
 *     byte[16] objectRefs[objectRefCount]
 *
 * Property tag, version 5:
 *   FString name, FString type, int32 size, int32 index, type-specific header,
 *   uint8 terminator, payload[size]
 *
 * Property tag, version 7:
 *   FString name, type-name tree, int32 size, uint8 flags,
 *   [int32 index if flags & 0x01], [byte[16] guid if flags & 0x02],
 *   payload[size]
 *
 * The type-name tree is Unreal's `FPropertyTypeName`: an FString followed by an
 * int32 parameter count and that many nested trees. `StructProperty` carries
 * its struct type and that type's package; `ArrayProperty` carries its element
 * type. This is why v7 needs no guessing about which structs are binary — the
 * tag says so outright.
 */

/** The save version at which Unreal 5.5's typed property tags took over. */
export const TAGGED_SAVE_VERSION = 7;

/**
 * Unreal's `EPropertyTagFlags`, used by version 7 tags.
 *
 * `BinarySerialize` is the useful one: it states outright whether a struct's
 * payload is packed binary, which version 5 left to the reader to guess.
 */
const TAG_FLAG = {
  hasIndex: 0x01,
  hasGuid: 0x02,
  hasExtensions: 0x04,
  binarySerialize: 0x08,
  boolTrue: 0x10,
} as const;

/** Bits the writer derives rather than preserves. */
const DERIVED_FLAGS = TAG_FLAG.hasIndex | TAG_FLAG.boolTrue;

/**
 * Version 5 only: struct types whose payload is packed binary rather than a
 * nested property list. Anything not named here is read as nested properties —
 * the safe default, because a wrong guess produces a parse error rather than
 * silent corruption. Version 7 tags say so explicitly and ignore this list.
 */
const BINARY_STRUCTS = new Set([
  "UniqueNetIdRepl",
  "LinearColor",
  "Color",
  "Vector",
  "Vector2D",
  "Rotator",
  "Quat",
  "IntPoint",
  "Transform",
  "Guid",
]);

/** Shared element header a version 5 array-of-structs declares before its items. */
export interface ArkArrayStructHeader {
  name: string;
  type: string;
  index: number;
  structName: string;
  guid: Uint8Array;
}

/** Unreal `FPropertyTypeName`: a name plus nested type parameters. */
export interface ArkTypeName {
  name: string;
  params: ArkTypeName[];
}

export interface ArkProperty {
  name: string;
  type: string;
  /**
   * Repeat index. ARK stores fixed-size game arrays as repeated properties
   * carrying an index, and omits entries that are still at their default — so
   * indices are sparse and must never be treated as positions in a list.
   */
  index: number;
  /**
   * Version 7: the tag's type parameters, preserved so the tag can be written
   * back exactly. `structName` and `innerType` below are read out of these.
   */
  typeParams?: ArkTypeName[];
  /** Version 7: `EPropertyTagFlags`. Index and bool bits are re-derived on write. */
  flags?: number;
  /** Version 7: the tag's property guid, when it carries one. */
  propertyGuid?: Uint8Array;
  /** Version 5 ByteProperty: the enum's name, or "None" for a plain byte. */
  enumName?: string;
  /** BoolProperty: its value sits outside the sized payload, so it lives here. */
  boolValue?: boolean;
  /** StructProperty: the struct's type name, and its version 5 guid. */
  structName?: string;
  structGuid?: Uint8Array;
  /** ArrayProperty: the element type name. */
  innerType?: string;
  /** A generic struct's nested properties. */
  children?: ArkProperty[];
  /** An array of structs: one property list per element. */
  items?: ArkProperty[][];
  itemHeader?: ArkArrayStructHeader;
  /**
   * Everything else: the payload bytes exactly as they sat on disk. For a
   * non-struct array this includes the leading element count, so the array
   * accessors work the same way in both save versions.
   */
  data?: Uint8Array;
}

export interface ArkObject {
  guid: Uint8Array;
  className: string;
  isItem: number;
  /** Instance name, game mode, level, map short name, map package path. */
  names: string[];
  /** Three int32s, zero in every profile seen; preserved rather than assumed. */
  unknown: [number, number, number];
  properties: ArkProperty[];
  /** Guids of the objects this one references (buff data, mostly). */
  objectRefs: Uint8Array[];
  /** Version 7: the byte the body opens with, ahead of the property list. */
  leadByte?: number;
}

export interface ArkProfile {
  saveVersion: number;
  /** Version 7: the UE4 and UE5 file versions the save was written against. */
  unrealVersions?: [number, number];
  objects: ArkObject[];
}

/** True when this profile uses the Unreal 5.5 tag format. */
export function isTagged(profile: { saveVersion: number }): boolean {
  return profile.saveVersion >= TAGGED_SAVE_VERSION;
}

export class ArkProfileError extends Error {}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

class Reader {
  readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number, what: string) {
    if (this.offset + n > this.bytes.length) {
      throw new ArkProfileError(
        `File ended while reading ${what} at byte ${this.offset} — this does not look like a complete .arkprofile`,
      );
    }
  }

  int32(): number {
    this.need(4, "an int32");
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  int64(): number {
    this.need(8, "an int64");
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    // Offsets are file positions; a profile large enough to lose precision here
    // would be 8 exabytes.
    return Number(v);
  }

  uint8(): number {
    this.need(1, "a byte");
    return this.bytes[this.offset++];
  }

  raw(n: number): Uint8Array {
    this.need(n, `${n} bytes`);
    const v = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }

  /** Unreal FString: int32 length, negative for UTF-16, always nul-terminated. */
  string(): string {
    const n = this.int32();
    if (n === 0) return "";
    if (n > 0) {
      const v = this.raw(n);
      return latin1Decode(v.subarray(0, n - 1));
    }
    const chars = -n;
    const v = this.raw(chars * 2);
    return utf16Decode(v.subarray(0, (chars - 1) * 2));
  }
}

class Writer {
  private parts: Uint8Array[] = [];
  private scratch = new DataView(new ArrayBuffer(8));
  length = 0;

  private push(bytes: Uint8Array) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  int32(v: number) {
    this.scratch.setInt32(0, v, true);
    this.push(new Uint8Array(this.scratch.buffer.slice(0, 4)));
  }

  int64(v: number) {
    this.scratch.setBigInt64(0, BigInt(v), true);
    this.push(new Uint8Array(this.scratch.buffer.slice(0, 8)));
  }

  uint8(v: number) {
    this.push(new Uint8Array([v & 0xff]));
  }

  raw(bytes: Uint8Array) {
    this.push(bytes);
  }

  string(v: string) {
    this.raw(encodeString(v));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/**
 * Encodes an FString. ASCII goes out as one byte per character; anything else
 * switches to UTF-16 with a negated length, which is how Unreal signals it.
 */
export function encodeString(value: string): Uint8Array {
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(value);
  if (value === "") return new Uint8Array(4); // length 0, no payload
  if (ascii) {
    const out = new Uint8Array(4 + value.length + 1);
    new DataView(out.buffer).setInt32(0, value.length + 1, true);
    for (let i = 0; i < value.length; i++) out[4 + i] = value.charCodeAt(i);
    return out;
  }
  const chars = value.length + 1;
  const out = new Uint8Array(4 + chars * 2);
  const view = new DataView(out.buffer);
  view.setInt32(0, -chars, true);
  for (let i = 0; i < value.length; i++) {
    view.setUint16(4 + i * 2, value.charCodeAt(i), true);
  }
  return out;
}

function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function utf16Decode(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(view.getUint16(i, true));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property list
// ---------------------------------------------------------------------------

function readTypeName(r: Reader): ArkTypeName {
  const name = r.string();
  const count = r.int32();
  if (count < 0 || count > 32) {
    throw new ArkProfileError(
      `Type '${name}' declares ${count} parameters at byte ${r.offset} — the property list is not aligned`,
    );
  }
  const params: ArkTypeName[] = [];
  for (let i = 0; i < count; i++) params.push(readTypeName(r));
  return { name, params };
}

function writeTypeName(w: Writer, type: ArkTypeName) {
  w.string(type.name);
  w.int32(type.params.length);
  for (const param of type.params) writeTypeName(w, param);
}

/** Version 7 property list: typed tags, no per-type header blocks. */
function readTaggedProperties(r: Reader): ArkProperty[] {
  const props: ArkProperty[] = [];
  for (;;) {
    const name = r.string();
    if (name === "None") return props;
    if (name === "") {
      throw new ArkProfileError(
        `Empty property name at byte ${r.offset} — the property list is not aligned`,
      );
    }
    const type = readTypeName(r);
    const size = r.int32();
    const flags = r.uint8();
    const prop: ArkProperty = {
      name,
      type: type.name,
      typeParams: type.params,
      index: 0,
      flags,
    };
    if (flags & TAG_FLAG.hasIndex) prop.index = r.int32();
    if (flags & TAG_FLAG.hasGuid) prop.propertyGuid = r.raw(16);
    if (flags & TAG_FLAG.hasExtensions) {
      throw new ArkProfileError(
        `Property '${name}' carries tag extensions, which this reader does not know how to skip`,
      );
    }

    const first = type.params[0]?.name ?? "";
    const binary = Boolean(flags & TAG_FLAG.binarySerialize);
    const end = r.offset + size;

    switch (type.name) {
      case "BoolProperty":
        // The value is a tag flag, not payload — the payload is empty.
        prop.boolValue = Boolean(flags & TAG_FLAG.boolTrue);
        break;
      case "StructProperty":
        prop.structName = first;
        if (binary) prop.data = r.raw(size);
        else {
          prop.children = readTaggedProperties(r);
          expectEnd(r, end, `struct ${first}`);
        }
        break;
      case "ArrayProperty":
        prop.innerType = first;
        if (first === "StructProperty" && !binary) {
          const count = r.int32();
          prop.items = [];
          for (let i = 0; i < count; i++) prop.items.push(readTaggedProperties(r));
          expectEnd(r, end, `array ${name}`);
        } else {
          prop.data = r.raw(size);
        }
        break;
      default:
        prop.data = r.raw(size);
        break;
    }
    props.push(prop);
  }
}

function writeTaggedProperties(w: Writer, props: ArkProperty[]) {
  for (const prop of props) {
    w.string(prop.name);
    writeTypeName(w, {
      name: prop.type,
      params: prop.typeParams ?? [],
    });

    const body = new Writer();
    if (prop.type === "BoolProperty") {
      // Nothing to write: the value rides in the flags below.
    } else if (prop.type === "StructProperty" && prop.children) {
      writeTaggedProperties(body, prop.children);
    } else if (prop.type === "ArrayProperty" && prop.items) {
      body.int32(prop.items.length);
      for (const item of prop.items) writeTaggedProperties(body, item);
    } else {
      body.raw(prop.data ?? new Uint8Array(0));
    }

    // The index and bool bits are derived so an edited value cannot disagree
    // with its own tag; everything else about the flags is preserved.
    let flags = (prop.flags ?? 0) & ~DERIVED_FLAGS;
    if (prop.index !== 0) flags |= TAG_FLAG.hasIndex;
    if (prop.type === "BoolProperty" && prop.boolValue) flags |= TAG_FLAG.boolTrue;

    w.int32(body.length);
    w.uint8(flags);
    if (flags & TAG_FLAG.hasIndex) w.int32(prop.index);
    if (flags & TAG_FLAG.hasGuid) {
      w.raw(prop.propertyGuid ?? new Uint8Array(16));
    }
    w.raw(body.toBytes());
  }
  w.string("None");
}

function readProperties(r: Reader): ArkProperty[] {
  const props: ArkProperty[] = [];
  for (;;) {
    const name = r.string();
    if (name === "None") return props;
    if (name === "") {
      throw new ArkProfileError(
        `Empty property name at byte ${r.offset} — the property list is not aligned`,
      );
    }
    const type = r.string();
    const size = r.int32();
    const index = r.int32();
    const prop: ArkProperty = { name, type, index };

    switch (type) {
      case "BoolProperty": {
        // The value precedes the terminator and is not counted in `size`.
        prop.boolValue = r.uint8() !== 0;
        r.uint8();
        break;
      }
      case "ByteProperty": {
        prop.enumName = r.string();
        r.uint8();
        prop.data = r.raw(size);
        break;
      }
      case "StructProperty": {
        prop.structName = r.string();
        prop.structGuid = r.raw(16);
        r.uint8();
        const end = r.offset + size;
        if (BINARY_STRUCTS.has(prop.structName)) {
          prop.data = r.raw(size);
        } else {
          prop.children = readProperties(r);
          expectEnd(r, end, `struct ${prop.structName}`);
        }
        break;
      }
      case "ArrayProperty": {
        prop.innerType = r.string();
        r.uint8();
        const end = r.offset + size;
        if (prop.innerType === "StructProperty") {
          const count = r.int32();
          // An array of structs declares the element shape once, then packs the
          // elements' property lists back to back. The declared element size is
          // dropped: it is recomputed on write, so keeping it invites drift.
          const headerName = r.string();
          const headerType = r.string();
          r.int32();
          const headerIndex = r.int32();
          const headerStruct = r.string();
          const headerGuid = r.raw(16);
          r.uint8();
          prop.itemHeader = {
            name: headerName,
            type: headerType,
            index: headerIndex,
            structName: headerStruct,
            guid: headerGuid,
          };
          prop.items = [];
          for (let i = 0; i < count; i++) prop.items.push(readProperties(r));
          expectEnd(r, end, `array ${name}`);
        } else {
          // Count and payload stay packed together — callers that care use the
          // array accessors rather than touching these bytes.
          prop.data = r.raw(end - r.offset);
        }
        break;
      }
      default: {
        r.uint8();
        prop.data = r.raw(size);
        break;
      }
    }
    props.push(prop);
  }
}

function expectEnd(r: Reader, end: number, what: string) {
  if (r.offset !== end) {
    throw new ArkProfileError(
      `${what} ended at byte ${r.offset} but its size said ${end} — the file is not laid out the way this reader expects`,
    );
  }
}

function writeProperties(w: Writer, props: ArkProperty[]) {
  for (const prop of props) {
    w.string(prop.name);
    w.string(prop.type);
    // The size is only known once the payload is written; the value is patched
    // in afterwards, so a nested edit can never leave a stale length behind.
    const body = new Writer();
    let size = 0;

    switch (prop.type) {
      case "BoolProperty":
        body.uint8(prop.boolValue ? 1 : 0);
        body.uint8(0);
        size = 0;
        break;
      case "ByteProperty":
        body.string(prop.enumName ?? "None");
        body.uint8(0);
        body.raw(prop.data ?? new Uint8Array(0));
        size = prop.data?.length ?? 0;
        break;
      case "StructProperty": {
        body.string(prop.structName ?? "");
        body.raw(prop.structGuid ?? new Uint8Array(16));
        body.uint8(0);
        const payload = new Writer();
        if (prop.children) writeProperties(payload, prop.children);
        else payload.raw(prop.data ?? new Uint8Array(0));
        size = payload.length;
        body.raw(payload.toBytes());
        break;
      }
      case "ArrayProperty": {
        body.string(prop.innerType ?? "");
        body.uint8(0);
        const payload = new Writer();
        if (prop.items && prop.itemHeader) {
          payload.int32(prop.items.length);
          payload.string(prop.itemHeader.name);
          payload.string(prop.itemHeader.type);
          const elements = new Writer();
          for (const item of prop.items) writeProperties(elements, item);
          payload.int32(elements.length);
          payload.int32(prop.itemHeader.index);
          payload.string(prop.itemHeader.structName);
          payload.raw(prop.itemHeader.guid);
          payload.uint8(0);
          payload.raw(elements.toBytes());
        } else {
          payload.raw(prop.data ?? new Uint8Array(0));
        }
        size = payload.length;
        body.raw(payload.toBytes());
        break;
      }
      default:
        body.uint8(0);
        body.raw(prop.data ?? new Uint8Array(0));
        size = prop.data?.length ?? 0;
        break;
    }

    w.int32(size);
    w.int32(prop.index);
    w.raw(body.toBytes());
  }
  w.string("None");
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export function parseArkProfile(bytes: Uint8Array): ArkProfile {
  if (bytes.length < 8) {
    throw new ArkProfileError("File is too small to be an .arkprofile");
  }
  const r = new Reader(bytes);
  const saveVersion = r.int32();
  if (saveVersion < 1 || saveVersion > 64) {
    throw new ArkProfileError(
      `Save version ${saveVersion} is not believable — this is probably not an .arkprofile`,
    );
  }
  const tagged = saveVersion >= TAGGED_SAVE_VERSION;
  const unrealVersions: [number, number] | undefined = tagged
    ? [r.int32(), r.int32()]
    : undefined;
  const objectCount = r.int32();
  // A profile always carries at least the player data object. Rejecting an
  // empty or absurd count here is what stops an unrelated file from parsing
  // "successfully" into nothing.
  if (objectCount < 1 || objectCount > 10000) {
    throw new ArkProfileError(
      `Object count of ${objectCount} is not believable — this is probably not an .arkprofile`,
    );
  }

  const objects: ArkObject[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    const guid = r.raw(16);
    const className = r.string();
    const isItem = r.int32();
    const nameCount = r.int32();
    const names: string[] = [];
    for (let n = 0; n < nameCount; n++) names.push(r.string());
    const unknown: [number, number, number] = [r.int32(), r.int32(), r.int32()];
    offsets.push(r.int64());
    objects.push({
      guid,
      className,
      isItem,
      names,
      unknown,
      properties: [],
      objectRefs: [],
    });
  }

  objects.forEach((object, i) => {
    const body = new Reader(bytes);
    body.offset = offsets[i];
    if (tagged) object.leadByte = body.uint8();
    object.properties = tagged ? readTaggedProperties(body) : readProperties(body);
    const refCount = body.int32();
    for (let n = 0; n < refCount; n++) object.objectRefs.push(body.raw(16));
  });

  return { saveVersion, unrealVersions, objects };
}

export function serializeArkProfile(profile: ArkProfile): Uint8Array {
  const tagged = isTagged(profile);

  // Bodies first: the object table stores absolute offsets, so their sizes have
  // to be known before the table can be written.
  const bodies = profile.objects.map((object) => {
    const w = new Writer();
    if (tagged) w.uint8(object.leadByte ?? 0);
    if (tagged) writeTaggedProperties(w, object.properties);
    else writeProperties(w, object.properties);
    w.int32(object.objectRefs.length);
    for (const ref of object.objectRefs) w.raw(ref);
    return w.toBytes();
  });

  const table = new Writer();
  table.int32(profile.saveVersion);
  if (tagged) {
    const [ue4, ue5] = profile.unrealVersions ?? [522, 1013];
    table.int32(ue4);
    table.int32(ue5);
  }
  table.int32(profile.objects.length);
  /** Byte position of each object's offset slot, so it can be patched. */
  const slots: number[] = [];
  profile.objects.forEach((object) => {
    table.raw(object.guid);
    table.string(object.className);
    table.int32(object.isItem);
    table.int32(object.names.length);
    for (const name of object.names) table.string(name);
    for (const value of object.unknown) table.int32(value);
    slots.push(table.length);
    table.int64(0);
  });

  const header = table.toBytes();
  const total = bodies.reduce((sum, b) => sum + b.length, header.length);
  const out = new Uint8Array(total);
  out.set(header, 0);
  const view = new DataView(out.buffer);
  let at = header.length;
  bodies.forEach((body, i) => {
    view.setBigInt64(slots[i], BigInt(at), true);
    out.set(body, at);
    at += body.length;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** First property with this name (and repeat index, when given). */
export function findProp(
  props: ArkProperty[] | undefined,
  name: string,
  index = 0,
): ArkProperty | undefined {
  return props?.find((p) => p.name === name && p.index === index);
}

/** Walks a chain of struct property names, e.g. `["MyData", "PlayerName"]`. */
export function findPath(
  props: ArkProperty[] | undefined,
  path: string[],
): ArkProperty | undefined {
  let current = props;
  for (let i = 0; i < path.length; i++) {
    const hit = findProp(current, path[i]);
    if (!hit) return undefined;
    if (i === path.length - 1) return hit;
    current = hit.children;
  }
  return undefined;
}

/** Every repeat of a name, in the order they appear (indices are sparse). */
export function findAll(
  props: ArkProperty[] | undefined,
  name: string,
): ArkProperty[] {
  return props?.filter((p) => p.name === name) ?? [];
}

/** Deep copy, so an edit can be prepared without disturbing the parsed original. */
export function cloneProfile(profile: ArkProfile): ArkProfile {
  return {
    saveVersion: profile.saveVersion,
    unrealVersions: profile.unrealVersions
      ? ([...profile.unrealVersions] as [number, number])
      : undefined,
    objects: profile.objects.map((object) => ({
      ...object,
      guid: copy(object.guid),
      names: [...object.names],
      unknown: [...object.unknown] as [number, number, number],
      properties: cloneProps(object.properties),
      objectRefs: object.objectRefs.map(copy),
    })),
  };
}

function cloneProps(props: ArkProperty[]): ArkProperty[] {
  return props.map((p) => ({
    ...p,
    data: p.data ? copy(p.data) : undefined,
    typeParams: p.typeParams ? cloneTypes(p.typeParams) : undefined,
    propertyGuid: p.propertyGuid ? copy(p.propertyGuid) : undefined,
    structGuid: p.structGuid ? copy(p.structGuid) : undefined,
    children: p.children ? cloneProps(p.children) : undefined,
    items: p.items?.map(cloneProps),
    itemHeader: p.itemHeader
      ? { ...p.itemHeader, guid: copy(p.itemHeader.guid) }
      : undefined,
  }));
}

function cloneTypes(types: ArkTypeName[]): ArkTypeName[] {
  return types.map((t) => ({ name: t.name, params: cloneTypes(t.params) }));
}

function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// Typed accessors
//
// Leaf payloads are stored as raw bytes, so reading and writing a value always
// goes through one of these. Readers return undefined rather than throwing:
// a field missing from an older profile is normal, not an error.
// ---------------------------------------------------------------------------

function viewOf(prop: ArkProperty | undefined, need: number): DataView | undefined {
  if (!prop?.data || prop.data.length < need) return undefined;
  return new DataView(prop.data.buffer, prop.data.byteOffset, prop.data.length);
}

export function readInt(prop: ArkProperty | undefined): number | undefined {
  return viewOf(prop, 4)?.getInt32(0, true);
}

export function readUint16(prop: ArkProperty | undefined): number | undefined {
  return viewOf(prop, 2)?.getUint16(0, true);
}

export function readUint64(prop: ArkProperty | undefined): bigint | undefined {
  return viewOf(prop, 8)?.getBigUint64(0, true);
}

export function readFloat(prop: ArkProperty | undefined): number | undefined {
  return viewOf(prop, 4)?.getFloat32(0, true);
}

export function readDouble(prop: ArkProperty | undefined): number | undefined {
  return viewOf(prop, 8)?.getFloat64(0, true);
}

export function readByte(prop: ArkProperty | undefined): number | undefined {
  return prop?.data?.length ? prop.data[0] : undefined;
}

export function readString(prop: ArkProperty | undefined): string | undefined {
  if (!prop?.data) return undefined;
  try {
    return new Reader(prop.data).string();
  } catch {
    return undefined;
  }
}

/** Element count of a non-struct array (the int32 its payload opens with). */
export function readArrayCount(prop: ArkProperty | undefined): number {
  if (prop?.items) return prop.items.length;
  return viewOf(prop, 4)?.getInt32(0, true) ?? 0;
}

/** The uint32 words of a `UInt32Property` array — used for the note bitmasks. */
export function readUint32Array(prop: ArkProperty | undefined): number[] {
  const view = viewOf(prop, 4);
  if (!view) return [];
  const count = view.getInt32(0, true);
  const out: number[] = [];
  for (let i = 0; i < count && 4 + i * 4 + 4 <= view.byteLength; i++) {
    out.push(view.getUint32(4 + i * 4, true));
  }
  return out;
}

/** The object paths of an `ObjectProperty` array (engram lists, mostly). */
export function readObjectArray(prop: ArkProperty | undefined): string[] {
  if (!prop?.data) return [];
  const r = new Reader(prop.data);
  const count = r.int32();
  const out: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      // Each entry is a kind marker followed by "<ClassType> <PackagePath>".
      r.int32();
      out.push(r.string());
    }
  } catch {
    // A truncated list still tells the admin what was learned up to that point.
  }
  return out;
}

function bytesFor(build: (view: DataView) => void, size: number): Uint8Array {
  const out = new Uint8Array(size);
  build(new DataView(out.buffer));
  return out;
}

export function writeInt(prop: ArkProperty, value: number) {
  prop.data = bytesFor((v) => v.setInt32(0, value, true), 4);
}

export function writeUint16(prop: ArkProperty, value: number) {
  prop.data = bytesFor((v) => v.setUint16(0, value, true), 2);
}

export function writeUint64(prop: ArkProperty, value: bigint) {
  prop.data = bytesFor((v) => v.setBigUint64(0, value, true), 8);
}

export function writeFloat(prop: ArkProperty, value: number) {
  prop.data = bytesFor((v) => v.setFloat32(0, value, true), 4);
}

export function writeByte(prop: ArkProperty, value: number) {
  prop.data = new Uint8Array([value & 0xff]);
}

export function writeString(prop: ArkProperty, value: string) {
  prop.data = encodeString(value);
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value: string): Uint8Array {
  const clean = value.trim().replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
