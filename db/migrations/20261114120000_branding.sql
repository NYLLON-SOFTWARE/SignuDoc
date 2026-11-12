-- An install's own logo and color.
--
-- The logo is small (512 KB at most) and there is exactly one, so it lives
-- in the settings row rather than in file storage: it is replaced and
-- removed in one statement, and nothing can be left behind. logo_hash is
-- the start of the image's SHA-256. The address the logo is served at
-- carries it, so that address can be cached for good and still changes
-- whenever the logo does. The color is stored as the administrator chose
-- it; the shades the pages use are worked out from it when a page is built.

alter table public.app_settings
  add column if not exists brand_color text,
  add column if not exists logo_content_type text,
  add column if not exists logo_data bytea,
  add column if not exists logo_hash text;

alter table public.app_settings
  drop constraint if exists app_settings_brand_color_check;

alter table public.app_settings
  add constraint app_settings_brand_color_check
    check (brand_color is null or brand_color ~ '^#[0-9a-f]{6}$');

alter table public.app_settings
  drop constraint if exists app_settings_logo_check;

alter table public.app_settings
  add constraint app_settings_logo_check
    check (
      (
        logo_data is null
        and logo_content_type is null
        and logo_hash is null
      )
      -- Each part is tested for null first: a check that comes out as
      -- "unknown" is not a failed check, and would let a half-set logo in.
      or (
        logo_data is not null
        and logo_content_type is not null
        and logo_hash is not null
        and logo_hash ~ '^[0-9a-f]{16}$'
        and logo_content_type in ('image/png', 'image/jpeg', 'image/webp')
        and octet_length(logo_data) between 1 and 524288
      )
    );
