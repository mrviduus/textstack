import { describe, it, expect } from 'vitest'
import { bumpPackages, latestVersions } from './nugetBump.mjs'

const PROPS = `<Project>
  <ItemGroup>
    <!-- Held on the 2.x line on purpose; the comment must survive the rewrite -->
    <PackageVersion Include="Microsoft.OpenApi" Version="2.7.5" />
    <PackageVersion Include="Dapper" Version="2.1.79" />
    <PackageVersion Include="SixLabors.ImageSharp" Version="3.1.11" />
    <PackageVersion Include="Npgsql" Version="10.0.2" />
  </ItemGroup>
</Project>
`

const outdated = (topLevelPackages) => ({
  projects: [{ path: 'Api.csproj', frameworks: [{ framework: 'net10.0', topLevelPackages }] }],
})

describe('latestVersions', () => {
  it('flattens every project and framework into one map', () => {
    expect(latestVersions({
      projects: [
        { frameworks: [{ topLevelPackages: [{ id: 'Dapper', latestVersion: '2.1.86' }] }] },
        { frameworks: [{ topLevelPackages: [{ id: 'Npgsql', latestVersion: '10.0.4' }] }] },
      ],
    })).toEqual({ Dapper: '2.1.86', Npgsql: '10.0.4' })
  })

  it('survives the shapes dotnet omits when nothing is outdated', () => {
    expect(latestVersions({})).toEqual({})
    expect(latestVersions({ projects: [{ path: 'x.csproj' }] })).toEqual({})
  })

  it('ignores an entry with no latest version', () => {
    expect(latestVersions(outdated([{ id: 'Dapper' }]))).toEqual({})
  })
})

describe('bumpPackages', () => {
  it('raises patch and minor, and leaves the comments and indentation alone', () => {
    const { text, applied, skipped } = bumpPackages(PROPS, {
      Dapper: '2.1.86',      // patch
      Npgsql: '10.1.0',      // minor
    })

    expect(applied).toEqual(['Dapper 2.1.79 → 2.1.86 (patch)', 'Npgsql 10.0.2 → 10.1.0 (minor)'])
    expect(skipped).toEqual([])
    expect(text).toContain('    <PackageVersion Include="Dapper" Version="2.1.86" />')
    expect(text).toContain('    <PackageVersion Include="Npgsql" Version="10.1.0" />')
    expect(text).toContain('<!-- Held on the 2.x line on purpose')
    // Untouched entries keep their exact line.
    expect(text).toContain('<PackageVersion Include="Microsoft.OpenApi" Version="2.7.5" />')
  })

  it('refuses a major and says so', () => {
    const { text, applied, skipped } = bumpPackages(PROPS, { 'SixLabors.ImageSharp': '4.0.1' })

    expect(applied).toEqual([])
    expect(skipped).toEqual(['SixLabors.ImageSharp 3.1.11 → 4.0.1 — major'])
    expect(text).toBe(PROPS)
  })

  it('ignores a package the manifest does not declare', () => {
    const { text, applied } = bumpPackages(PROPS, { 'Some.Transitive.Thing': '9.9.9' })
    expect(applied).toEqual([])
    expect(text).toBe(PROPS)
  })

  it('does nothing when latest equals declared', () => {
    const { text, applied, skipped } = bumpPackages(PROPS, { Dapper: '2.1.79' })
    expect(applied).toEqual([])
    expect(skipped).toEqual([])
    expect(text).toBe(PROPS)
  })

  it('holds a lockstep pair when the two are offered different versions', () => {
    const props = `<Project>
  <ItemGroup>
    <PackageVersion Include="ModelContextProtocol" Version="1.4.0" />
    <PackageVersion Include="ModelContextProtocol.AspNetCore" Version="1.4.0" />
    <PackageVersion Include="Dapper" Version="2.1.79" />
  </ItemGroup>
</Project>
`
    const { text, applied, skipped } = bumpPackages(props, {
      ModelContextProtocol: '1.5.0',
      'ModelContextProtocol.AspNetCore': '1.4.2',
      Dapper: '2.1.86',
    })

    // The unrelated package still moves; the pair does not, at either version.
    expect(applied).toEqual(['Dapper 2.1.79 → 2.1.86 (patch)'])
    expect(skipped).toEqual([
      'ModelContextProtocol + ModelContextProtocol.AspNetCore — must move together, offered 1.5.0 vs 1.4.2',
    ])
    expect(text).toContain('<PackageVersion Include="ModelContextProtocol" Version="1.4.0" />')
    expect(text).toContain('<PackageVersion Include="ModelContextProtocol.AspNetCore" Version="1.4.0" />')
  })

  it('moves a lockstep pair when both are offered the same version', () => {
    const props = `<Project>
  <ItemGroup>
    <PackageVersion Include="ModelContextProtocol" Version="1.4.0" />
    <PackageVersion Include="ModelContextProtocol.AspNetCore" Version="1.4.0" />
  </ItemGroup>
</Project>
`
    const { applied, skipped } = bumpPackages(props, {
      ModelContextProtocol: '1.5.0',
      'ModelContextProtocol.AspNetCore': '1.5.0',
    })

    expect(applied).toEqual([
      'ModelContextProtocol 1.4.0 → 1.5.0 (minor)',
      'ModelContextProtocol.AspNetCore 1.4.0 → 1.5.0 (minor)',
    ])
    expect(skipped).toEqual([])
  })

  it('never moves a version downwards', () => {
    const { text, applied, skipped } = bumpPackages(PROPS, { Dapper: '2.1.70', Npgsql: '9.9.9' })
    expect(applied).toEqual([])
    expect(skipped).toEqual([])
    expect(text).toBe(PROPS)
  })
})
