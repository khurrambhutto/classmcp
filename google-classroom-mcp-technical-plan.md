# Technical Plan: Local Google Classroom MCP

## 1. Product

- Local-only MCP server
- No hosted backend, database, or centralized OAuth
- One Google account per installation
- Supports Codex, OpenCode, Antigravity, Claude Code, and Cursor
- Supports macOS, Linux, and Windows

## 2. Technology

- TypeScript
- Node.js
- Official MCP TypeScript SDK
- Google Classroom API
- Google Drive API
- npm package: `@your-scope/google-classroom-mcp`

## 3. Installation

The website provides an agent prompt that runs:

```bash
npx -y @your-scope/google-classroom-mcp@1.0.0 setup
```

The setup CLI will:

- Check Node.js and npm
- Search `Downloads` for OAuth credentials
- Ask for the credentials path if not found
- Validate the credentials
- Guide the student through Google Cloud API enablement
- Open browser-based OAuth login
- Store tokens in the OS credential store
- Detect supported MCP clients
- Ask permission before editing client configuration
- Register the local stdio MCP server
- Verify authentication and list all courses

No `sudo` should be required.

## 4. MCP Tools

- `list_courses`
- `list_assignments`
- `get_assignment`
- `list_materials`
- `download_material`
- `upload_local_file`
- `attach_file_to_submission`
- `turn_in_submission`

The agent must identify the exact course and assignment when multiple matches exist.

## 5. Permissions

- Classroom read access
- Student submission access
- Drive read-only access for downloading materials
- Narrow Drive file-write access for uploaded submission files
- Explicit student confirmation immediately before turning in work

## 6. Security

- OAuth credentials remain local
- Refresh tokens use Keychain, Credential Manager, or Secret Service
- No credentials committed to npm or GitHub
- No arbitrary file uploads
- No automatic turn-in
- Validate local paths and file sizes

## 7. Verification

Setup must verify:

- OAuth authentication
- Classroom API access
- Drive API access
- MCP client configuration
- Successful retrieval of all courses

If courses are missing, the agent diagnoses the account, permissions, API, and school-admin restrictions.

## 8. Testing

- Unit tests for Google API services
- OAuth and credential validation tests
- Mocked upload and submission tests
- Cross-platform setup tests
- Manual tests in each supported MCP client
- Test that turn-in always requires confirmation
