# Polling Tool

A static polling app designed for GitHub Pages with optional Supabase storage.

## What It Does
- Create polls with multiple questions.
- Poll types:
  - `Select one` (single choice)
  - `Pick favorite` (single choice, different label)
  - `Ranking` (rank all options)
- Optional free-text answer per question (requires input if selected).
- Live template preview (variables like `{topic}`).
- Public aggregated results (counts only).
- Admin-only create/edit/finalize and full results.

## File Layout
- `index.html` - UI layout and templates.
- `app.js` - App logic (admin, voting, Supabase integration).
- `styles.css` - Small custom styles (fonts + tweaks).

## Hosting
This repo is set up for GitHub Pages and expects the site to be served from the repo root.

## Supabase (Recommended)
Supabase stores polls and votes and enables admin access via email magic links.

### 1) Add your keys
In `app.js`, set:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (publishable/anon key)

### 2) Create tables
```sql
create table if not exists polls (
  id text primary key,
  title text not null,
  description text,
  type text not null,
  template text,
  questions jsonb not null,
  status text not null default 'active',
  summary text,
  results jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  poll_id text not null references polls(id) on delete cascade,
  answers jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists admin_emails (
  email text primary key
);
```

### 3) Insert allowlisted admins
```sql
insert into admin_emails (email) values ('p.lacerda@nlspacecampus.eu')
on conflict do nothing;
```

### 4) Enable RLS + policies
```sql
alter table polls enable row level security;
alter table votes enable row level security;

-- Public can read active polls only (results are stored in polls.results)
create policy "polls_public_read_active"
on public.polls for select
using (status = 'active');

-- Admin-only poll management
create policy "polls_admin_insert"
on public.polls for insert
to authenticated
with check (exists (select 1 from admin_emails where email = lower(auth.email())));

create policy "polls_admin_update"
on public.polls for update
to authenticated
using (exists (select 1 from admin_emails where email = lower(auth.email())));

-- Admin-only access to raw votes
create policy "votes_admin_read"
on public.votes for select
to authenticated
using (exists (select 1 from admin_emails where email = lower(auth.email())));

create policy "votes_admin_delete"
on public.votes for delete
to authenticated
using (exists (select 1 from admin_emails where email = lower(auth.email())));
```

### 5) RPC for public voting
This function stores a vote and updates aggregated results (counts only for single-choice, point totals for ranking).

```sql
create or replace function submit_vote(p_poll_id text, p_answers jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_poll polls%rowtype;
  v_results jsonb;
begin
  select * into v_poll from polls where id = p_poll_id and status = 'active';
  if not found then
    raise exception 'Poll not found';
  end if;

  insert into votes (poll_id, answers) values (p_poll_id, p_answers);

  v_results := jsonb_build_object('type', v_poll.type, 'questions', '[]'::jsonb);
  v_results := jsonb_set(
    v_results,
    '{questions}',
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', q->>'id',
          'prompt', q->>'prompt',
          'total', (select count(*) from votes where poll_id = p_poll_id),
          'options', (
            select jsonb_agg(
              jsonb_build_object(
                'label', opt,
                'count', case
                  when v_poll.type = 'ranking' then null
                  else (
                    select count(*) from votes v
                    where v.poll_id = p_poll_id
                    and (
                      (v.answers->>(q->>'id')) = opt
                      or (
                        (v.answers->(q->>'id')) ? 'type'
                        and (v.answers->(q->>'id'))->>'type' = 'free'
                        and opt = coalesce(q->>'freeTextLabel', 'Other')
                      )
                    )
                  )
                end,
                'score', case
                  when v_poll.type <> 'ranking' then null
                  else (
                    select coalesce(sum((ranked.total - ranked.position) + 1), 0)
                    from (
                      select
                        jsonb_array_elements_text(v.answers->(q->>'id')) with ordinality as ranked(option, position),
                        jsonb_array_length(v.answers->(q->>'id')) as total
                      from votes v
                      where v.poll_id = p_poll_id
                    ) ranked
                    where ranked.option = opt
                  )
                end
              )
            )
            from jsonb_array_elements_text(q->'options') as opt
            union all
            select jsonb_build_object(
              'label', coalesce(q->>'freeTextLabel', 'Other'),
              'count', (
                select count(*) from votes v
                where v.poll_id = p_poll_id
                and (v.answers->(q->>'id')) ? 'type'
                and (v.answers->(q->>'id'))->>'type' = 'free'
              ),
              'score', null
            )
            where (q->>'allowFreeText')::boolean = true
          )
        )
      )
      from jsonb_array_elements(v_poll.questions) as q
    )
  );

  update polls set results = v_results where id = p_poll_id;
end;
$$;

grant execute on function submit_vote(text, jsonb) to anon;
```

## Local-only Mode (No Supabase)
If Supabase keys are blank, polls and votes are stored in localStorage.

## Notes
- The anon (publishable) key is safe for the client.
- Do **not** use the service role key in the browser.
- Magic link login can be rate-limited; wait a few minutes if you see 429 errors.

## Deploy
1. Commit your changes.
2. GitHub -> Settings -> Pages -> Source: main branch -> Folder: `/`.
