ALTER TABLE accounts ADD CONSTRAINT accounts_id_owner UNIQUE(id,user_id);
ALTER TABLE pairs ADD CONSTRAINT pairs_google_owner FOREIGN KEY(google_id,user_id) REFERENCES accounts(id,user_id);
ALTER TABLE pairs ADD CONSTRAINT pairs_microsoft_owner FOREIGN KEY(microsoft_id,user_id) REFERENCES accounts(id,user_id);
ALTER TABLE pairs ADD CONSTRAINT pairs_id_owner UNIQUE(id,user_id);
ALTER TABLE jobs ADD CONSTRAINT jobs_pair_owner FOREIGN KEY(pair_id,user_id) REFERENCES pairs(id,user_id) ON DELETE CASCADE;
