-- SQLite. Execute PRAGMA foreign_keys = ON em TODA conexão do backend.
PRAGMA foreign_keys = ON;
BEGIN;
CREATE TABLE users (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE sources (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 kind TEXT NOT NULL CHECK(kind IN ('book','compendium','homebrew')),
 owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
 reference TEXT,
 CHECK(kind <> 'homebrew' OR owner_user_id IS NOT NULL)
);
CREATE TABLE schools (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL UNIQUE
);
CREATE TABLE classes (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 search_name TEXT NOT NULL,
 source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
 UNIQUE(source_id, name)
);
CREATE TABLE spells (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 search_name TEXT NOT NULL,
 level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 9),
 school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
 source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
 components_text TEXT NOT NULL,
 casting_time_text TEXT NOT NULL,
 range_text TEXT NOT NULL,
 duration_text TEXT NOT NULL,
 description_text TEXT NOT NULL,
 image_path TEXT,
 source_page INTEGER CHECK(source_page IS NULL OR source_page > 0),
 source_school_text TEXT,
 original_entry_json TEXT CHECK(original_entry_json IS NULL OR json_valid(original_entry_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(source_id,name)
);
-- Uma origem registra a inclusão de uma magia em uma classe.
-- A mesma magia pode ter vínculos de origens diferentes.
CREATE TABLE class_spells (
 id INTEGER PRIMARY KEY,
 class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
 spell_id INTEGER NOT NULL REFERENCES spells(id) ON DELETE RESTRICT,
 source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
 UNIQUE(class_id,spell_id,source_id)
);
CREATE TABLE characters (
 id INTEGER PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(trim(name)) > 0),
 level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 20),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Referencia o vínculo escolhido: preserva a origem que autorizou a preparação.
CREATE TABLE prepared_spells (
 character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
 class_spell_id INTEGER NOT NULL REFERENCES class_spells(id) ON DELETE RESTRICT,
 prepared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(character_id,class_spell_id)
);
CREATE INDEX idx_characters_user ON characters(user_id);
CREATE INDEX idx_characters_class ON characters(class_id);
CREATE INDEX idx_spells_search ON spells(search_name);
CREATE INDEX idx_spells_school ON spells(school_id);
CREATE INDEX idx_spells_source ON spells(source_id);
CREATE INDEX idx_classes_source ON classes(source_id);
CREATE INDEX idx_class_spells_spell ON class_spells(spell_id);
CREATE INDEX idx_class_spells_source ON class_spells(source_id);
CREATE INDEX idx_prepared_link ON prepared_spells(class_spell_id);
CREATE INDEX idx_sources_owner ON sources(owner_user_id);

CREATE TRIGGER prepared_insert_validate BEFORE INSERT ON prepared_spells
BEGIN
 SELECT RAISE(ABORT,'Magia indisponível para este personagem') WHERE NOT EXISTS (
  SELECT 1 FROM characters c
  JOIN class_spells cs ON cs.id=NEW.class_spell_id AND cs.class_id=c.class_id
  JOIN spells s ON s.id=cs.spell_id
  JOIN classes cl ON cl.id=c.class_id
  JOIN sources ss ON ss.id=s.source_id
  JOIN sources ls ON ls.id=cs.source_id
  JOIN sources cls ON cls.id=cl.source_id
  WHERE c.id=NEW.character_id
   AND (ss.owner_user_id IS NULL OR ss.owner_user_id=c.user_id)
   AND (ls.owner_user_id IS NULL OR ls.owner_user_id=c.user_id)
   AND (cls.owner_user_id IS NULL OR cls.owner_user_id=c.user_id)
 );
 SELECT RAISE(ABORT,'Magia já preparada') WHERE EXISTS (
  SELECT 1 FROM prepared_spells p JOIN class_spells old ON old.id=p.class_spell_id
  JOIN class_spells new ON new.spell_id=old.spell_id
  WHERE p.character_id=NEW.character_id AND new.id=NEW.class_spell_id
 );
END;
-- Preparar/despreparar usa INSERT/DELETE, nunca UPDATE.
CREATE TRIGGER prepared_no_update BEFORE UPDATE ON prepared_spells
BEGIN SELECT RAISE(ABORT,'Desprepare e prepare novamente'); END;
CREATE TRIGGER class_spells_no_update BEFORE UPDATE ON class_spells
BEGIN SELECT RAISE(ABORT,'Vínculo imutável: remova e crie outro'); END;
CREATE TRIGGER character_class_change BEFORE UPDATE OF class_id ON characters
WHEN NEW.class_id <> OLD.class_id
BEGIN
 SELECT RAISE(ABORT,'Desprepare as magias antes de trocar de classe')
 WHERE EXISTS(SELECT 1 FROM prepared_spells WHERE character_id=OLD.id);
END;
CREATE TRIGGER character_owner_no_update BEFORE UPDATE OF user_id ON characters
WHEN NEW.user_id <> OLD.user_id
BEGIN SELECT RAISE(ABORT,'O dono do personagem não pode ser alterado'); END;
-- Não alterar o escopo de acesso de conteúdo que já existe.
CREATE TRIGGER source_scope_no_update BEFORE UPDATE OF owner_user_id,kind ON sources
WHEN NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT,'Crie uma nova origem para alterar autoria ou tipo'); END;
CREATE TRIGGER spell_source_no_update BEFORE UPDATE OF source_id ON spells
WHEN NEW.source_id <> OLD.source_id
BEGIN SELECT RAISE(ABORT,'A origem da magia é imutável'); END;
CREATE TRIGGER class_source_no_update BEFORE UPDATE OF source_id ON classes
WHEN NEW.source_id <> OLD.source_id
BEGIN SELECT RAISE(ABORT,'A origem da classe é imutável'); END;
PRAGMA user_version = 1;
COMMIT;
