import { CObject, CPrimitive } from "../constructions";
import { Collab } from "../core";
import { MakeAbstractList } from "./abstract_list";

export const AbstractList_Collab = MakeAbstractList(Collab);
export const AbstractList_CObject = MakeAbstractList(CObject);
export const AbstractList_CPrimitive = MakeAbstractList(CPrimitive);
