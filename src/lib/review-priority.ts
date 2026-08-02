import type { UnitKind } from "~/server/analysis/types";

export interface PrioritizableReviewUnit {
  path: string;
  name: string;
  kind: UnitKind;
  source: string;
}

export interface ReviewFoundationPriority {
  rank: 0 | 1 | 2;
  foundation: boolean;
  reason?: "schema" | "data_shape";
}

const schemaPathPattern =
  /(?:^|\/)(?:schemas?|models?|entities|entity|dtos?|migrations?)(?:\/|$)|(?:^|\/)(?:schema|models?|entities|types?|typedefs?|openapi|swagger)(?:\.[^/]*)?$|\.(?:model|entity|dto)\.[^/]+$|\.(?:sql|prisma|graphql|gql|proto|avsc)$/i;
const schemaNamePattern =
  /(?:Schema|Model|Entity|Dto|DTO|Record|Document|Table|TypeDef)$/;
const explicitSchemaPattern =
  /\b(?:pgTable|mysqlTable|sqliteTable|defineTable|createTable|mongoose\.model|z\.object|Type\.Object)\s*\(|\b(?:CREATE|ALTER)\s+(?:TABLE|TYPE)\b|\$schema\s*[":]|\bopenapi\s*[:=]|@Entity\b|#\[[^\]]*Entity\b|\[Table\b|\b__tablename__\b|\bvariable\s+"[^"]+"\s*\{|\bextends\s+(?:BaseModel|Model)\b|\bclass\s+\w+\s*\([^)]*(?:models\.Model|Base)[^)]*\)|<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/i;
const dataShapePattern =
  /\b(?:interface|enum|struct|record|data\s+class)\s+[A-Za-z_$]|\btype\s+[A-Za-z_$][\w$]*(?:<[^>]+>)?\s*=|@dataclass\b|---@class\b|\b(?:TypedDict|NamedTuple|BaseModel)\b|\bclass\s+[A-Za-z_$][\w$]*\s*\([^)]*(?:BaseModel|TypedDict|NamedTuple)[^)]*\)|\btype\s+[A-Za-z_$][\w$]*\s+struct\b/i;

/** Classifies whether a unit establishes data vocabulary for later behavior. */
export function reviewFoundationPriority(
  unit: PrioritizableReviewUnit,
): ReviewFoundationPriority {
  if (
    schemaPathPattern.test(unit.path) ||
    schemaNamePattern.test(unit.name) ||
    explicitSchemaPattern.test(unit.source)
  ) {
    return { rank: 0, foundation: true, reason: "schema" };
  }
  if (unit.kind === "class" && dataShapePattern.test(unit.source)) {
    return { rank: 1, foundation: true, reason: "data_shape" };
  }
  return { rank: 2, foundation: false };
}
