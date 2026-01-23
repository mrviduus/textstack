# QA-003: SSG Rebuild Admin Feature

**Area**: Admin, SSG, Pre-rendering
**Priority**: Medium
**Last Tested**: —
**Status**: Not Tested

---

## Preconditions

- [ ] Docker services running (`docker compose up -d`)
- [ ] Admin account exists (admin@textstack.app / admin123)
- [ ] At least 1 published book in database
- [ ] Browser open at http://localhost:5174

---

## Steps

### 1. Admin Login

1. Open admin panel: http://localhost:5174
2. Login with `admin@textstack.app` / `admin123`

**Verify**:
- [ ] Login successful, redirected to dashboard
- [ ] "SSG Rebuild" link visible in sidebar navigation

---

### 2. SSG Rebuild Page - Empty State

1. Click "SSG Rebuild" in sidebar

**Verify**:
- [ ] Page loads without errors
- [ ] Job list displays (may be empty or have previous jobs)
- [ ] "New Rebuild" button visible
- [ ] Status filter dropdown present

---

### 3. Create New Rebuild Job - Preview

1. Click "New Rebuild" button
2. Observe the create form

**Verify**:
- [ ] Form expands with options
- [ ] Mode selector shows: Full, Incremental, Specific
- [ ] Concurrency input visible (default: 4)
- [ ] "Loading route count..." appears briefly
- [ ] Preview box shows route counts:
  - [ ] Total routes count
  - [ ] Static pages count (should be 4)
  - [ ] Books count
  - [ ] Authors count
  - [ ] Genres count

---

### 4. Create Full Rebuild Job

1. Keep mode as "Full"
2. Set concurrency to 2
3. Click "Create Job"

**Verify**:
- [ ] Form closes
- [ ] New job appears in job list
- [ ] Job status = "Queued"
- [ ] Progress shows 0%
- [ ] "Start" button visible for the job

---

### 5. Start Job

1. Find the queued job in the list
2. Click "Start" button

**Verify**:
- [ ] Job status changes to "Running"
- [ ] "Start" button replaced with "Cancel" button
- [ ] Progress bar starts updating (may take a moment)

---

### 6. View Job Details

1. Click "View" button on the running job
2. Observe job detail page

**Verify**:
- [ ] Job detail page loads
- [ ] Shows job ID, mode, status
- [ ] Progress bar with percentage
- [ ] Stats grid:
  - [ ] Total routes
  - [ ] Successful renders
  - [ ] Failed renders
  - [ ] Avg render time (ms)
- [ ] Route breakdown by type (books, authors, genres, static)
- [ ] "Back to Jobs" link works

---

### 7. Cancel Job

1. Return to job list
2. Create a new job (or use existing queued job)
3. Start the job
4. Click "Cancel" button

**Verify**:
- [ ] Job status changes to "Cancelled"
- [ ] No more "Cancel" or "Start" buttons
- [ ] Job remains in list with final stats

---

### 8. Filter Jobs by Status

1. Use status dropdown to filter:
   - [ ] "All Status" - shows all jobs
   - [ ] "Queued" - shows only queued jobs
   - [ ] "Running" - shows only running jobs
   - [ ] "Completed" - shows only completed jobs
   - [ ] "Cancelled" - shows only cancelled jobs

**Verify**:
- [ ] Filtering works correctly
- [ ] "Refresh" button updates list

---

### 9. Specific Mode

1. Click "New Rebuild"
2. Change mode to "Specific"
3. Observe preview

**Verify**:
- [ ] Preview updates with different route count
- [ ] (If slug selectors implemented) Book/author/genre selectors appear

---

### 10. API Direct Test (Optional)

Test via curl:

```bash
# Get token
TOKEN=$(curl -s -X POST "http://localhost:8080/admin/auth/login" \
  -H "Content-Type: application/json" \
  -H "Host: general.localhost" \
  -d '{"email":"admin@textstack.app","password":"admin123"}' \
  -v 2>&1 | grep "admin_access_token=" | sed 's/.*admin_access_token=\([^;]*\).*/\1/')

# Preview
curl -s "http://localhost:8080/admin/ssg/preview?siteId=11111111-1111-1111-1111-111111111111" \
  -H "Host: general.localhost" \
  -H "Cookie: admin_access_token=$TOKEN"

# List jobs
curl -s "http://localhost:8080/admin/ssg/jobs?siteId=11111111-1111-1111-1111-111111111111" \
  -H "Host: general.localhost" \
  -H "Cookie: admin_access_token=$TOKEN"
```

**Verify**:
- [ ] Preview returns JSON with route counts
- [ ] Jobs list returns JSON with items array

---

## Expected Results

| Check | Expected |
|-------|----------|
| Preview loads | Shows accurate route counts |
| Job creation | Returns 201 with job ID |
| Job list | Shows all jobs with pagination |
| Job start | Status changes to Running |
| Job cancel | Status changes to Cancelled |
| Job detail | Shows stats and progress |
| Status filter | Filters correctly |

---

## Key Endpoints Tested

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/ssg/preview` | GET | Route count preview |
| `/admin/ssg/jobs` | POST | Create new job |
| `/admin/ssg/jobs` | GET | List jobs |
| `/admin/ssg/jobs/{id}` | GET | Job details |
| `/admin/ssg/jobs/{id}/start` | POST | Start job |
| `/admin/ssg/jobs/{id}/cancel` | POST | Cancel job |
| `/admin/ssg/jobs/{id}/stats` | GET | Job statistics |
| `/admin/ssg/jobs/{id}/results` | GET | Render results |

---

## Actual Issues Observed

_Document any bugs found during testing:_

| Date | Issue | Status |
|------|-------|--------|
| — | — | — |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| — | — | — | — |
