-- People who receive a copy of the finished document without signing it.
--
-- They live in the signers table, marked by role, so that everything keyed
-- to a recipient already covers them: download links, the signer data
-- request tools and the retention period. A copy recipient is never part
-- of the signing order: it stays 'pending' and never holds a signing link.

alter table public.signers
  add column if not exists role text not null default 'signer';

alter table public.signers
  drop constraint if exists signers_role_check;

alter table public.signers
  add constraint signers_role_check check (role in ('signer', 'cc'));

alter table public.signers
  drop constraint if exists signers_copy_recipient_never_signs;

alter table public.signers
  add constraint signers_copy_recipient_never_signs
    check (
      role = 'signer'
      or (status = 'pending' and signing_token_hash is null)
    );
