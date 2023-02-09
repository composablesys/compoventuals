import { CObject, CPrimitive } from "../constructions";
import { Collab } from "../core";
import { MakeAbstractMap } from "./abstract_map";

export const AbstractMap_Collab = MakeAbstractMap(Collab);
export const AbstractMap_CObject = MakeAbstractMap(CObject);
export const AbstractMap_CPrimitive = MakeAbstractMap(CPrimitive);