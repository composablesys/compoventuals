import { ItemManager } from "./position_source";

export class StringItemManager implements ItemManager<string> {
  private constructor() {
    // Private constructor, use instance instead.
  }

  static instance = new StringItemManager();

  length(item: string): number {
    return item.length;
  }

  get(item: string, index: number): string {
    return item.charAt(index);
  }

  merge(a: string, b: string): string {
    return a + b;
  }

  merge3(a: string, b: string, c: string): string {
    return a + b + c;
  }

  split(item: string, index: number): [left: string, right: string] {
    return [item.slice(0, index), item.slice(index)];
  }

  splitDelete(item: string, index: number): [left: string, right: string] {
    return [item.slice(0, index), item.slice(index + 1)];
  }

  trimFirst(item: string): string {
    return item.slice(1);
  }

  trimLast(item: string): string {
    return item.slice(0, -1);
  }
}
