import { resolve } from "node:path";

function recordLabel(record, recordType) {
  if (recordType === "fix") return record.summary;
  if (recordType === "research") return record.question;
  if (recordType === "decision") return record.decision;
  return `${recordType}:${record.id}`;
}

export function extractDeterministicEntities(record) {
  const entities = [
    {
      entityType: "project",
      canonicalKey: record.projectPath,
      label: record.projectPath,
      projectPath: record.projectPath,
      linkType: "belongs_to_project",
      role: "project",
    },
    {
      entityType: "agent",
      canonicalKey: record.agent.toLowerCase(),
      label: record.agent,
      projectPath: record.projectPath,
      linkType: "related_to",
      role: "agent",
    },
  ];
  for (const file of record.filesChanged || []) {
    entities.push({
      entityType: "file",
      canonicalKey: resolve(record.projectPath, file),
      label: file,
      projectPath: record.projectPath,
      linkType: "changes_file",
      role: "changed_file",
    });
  }
  if (record.commitSha) {
    entities.push({
      entityType: "commit",
      canonicalKey: record.commitSha.toLowerCase(),
      label: record.commitSha,
      projectPath: record.projectPath,
      linkType: "fixed_by_commit",
      role: "commit",
    });
  }
  for (const tag of record.reuseTags || []) {
    entities.push({
      entityType: "tag",
      canonicalKey: tag.toLowerCase(),
      label: tag,
      projectPath: record.projectPath,
      linkType: "related_to",
      role: "tag",
    });
  }
  return entities;
}

export function linkCapturedRecord(storage, record, recordType) {
  const recordEntity = storage.upsertEntity({
    entityType: "record",
    canonicalKey: `${recordType}:${record.id}`,
    label: recordLabel(record, recordType),
    projectPath: record.projectPath,
    metadata: { recordId: record.id, recordType },
  });
  storage.attachRecordEntity({
    recordId: record.id,
    recordType,
    entityId: recordEntity.id,
    role: "subject",
  });
  for (const specification of extractDeterministicEntities(record)) {
    const entity = storage.upsertEntity(specification);
    storage.attachRecordEntity({
      recordId: record.id,
      recordType,
      entityId: entity.id,
      role: specification.role,
    });
    storage.linkRecords({
      fromEntityId: recordEntity.id,
      toEntityId: entity.id,
      linkType: specification.linkType,
      source: "deterministic",
      confidence: 1,
      originRecordId: record.id,
    });
  }
  return recordEntity;
}

export function ensureRecordLinks(storage) {
  const missing = storage.db.prepare(`
    SELECT record.id, 'fix' AS recordType FROM fix_entries AS record
    WHERE NOT EXISTS (
      SELECT 1 FROM record_entities AS attachment
      WHERE attachment.record_id = record.id AND attachment.role = 'subject'
    )
    UNION ALL
    SELECT record.id, 'research' AS recordType FROM research_entries AS record
    WHERE NOT EXISTS (
      SELECT 1 FROM record_entities AS attachment
      WHERE attachment.record_id = record.id AND attachment.role = 'subject'
    )
  `).all();
  storage.transaction(() => {
    for (const item of missing) {
      const record = item.recordType === "fix" ? storage.getFix(item.id) : storage.getResearch(item.id);
      if (record) linkCapturedRecord(storage, record, item.recordType);
    }
  });
  return { linked: missing.length };
}
