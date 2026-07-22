import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { hclAdapter, hclParserInternals, isContextOnly } from ".";

/** Analyzes an in-memory HCL fixture with a representative Terraform path. */
function analyze(content: string, path = "infra/main.tf") {
  return hclAdapter.analyze({ path, content, changeType: "added" });
}

/** Finds a fixture unit by display name and reports useful failure context. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map(({ kind, name: unitName }) => `${kind}:${unitName}`).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing ${name}`);
  return unit;
}

describe("HCL and Terraform review analysis", () => {
  it("extracts native Terraform concepts, documentation, and dependency flow", () => {
    const units = analyze(`terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

# Region selected by the deployment owner.
variable "region" {
  type    = string
  default = "eu-west-1"
}

provider "aws" {
  alias  = "workload"
  region = var.region
}

locals {
  # Stable prefix for named resources.
  prefix = "reviewduck-\${var.region}"
  tags = {
    Service = local.prefix
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

resource "aws_instance" "web" {
  ami  = data.aws_ami.ubuntu.id
  tags = local.tags

  lifecycle {
    precondition {
      condition     = var.region != ""
      error_message = "region must be configured"
    }
  }
}

module "network" {
  source = "./network"
  name   = local.prefix
}

output "instance_id" {
  value = aws_instance.web.id
}
`);

    expect(hclAdapter.extensions).toBeDefined();
    expect(hclAdapter.extensions).toContain(".tf");
    expect(named(units, "Terraform configuration").kind).toBe("module");
    const region = named(units, "Variable region");
    expect(region.kind).toBe("variable");
    expect(region.source).toContain("Region selected");
    const provider = named(units, "Provider aws.workload");
    expect(provider.dependencies).toContain(region.stableKey);

    const prefix = named(units, "Local prefix");
    expect(prefix.source).toContain("Stable prefix");
    expect(prefix.dependencies).toContain(region.stableKey);
    const tags = named(units, "Local tags");
    expect(tags.dependencies).toContain(prefix.stableKey);
    expect(prefix.source).not.toContain("tags =");

    const image = named(units, "Data aws_ami.ubuntu");
    const instance = named(units, "aws_instance.web");
    expect(instance.source).toContain("lifecycle");
    expect(instance.dependencies).toEqual(
      expect.arrayContaining([
        region.stableKey,
        tags.stableKey,
        image.stableKey,
      ]),
    );
    expect(named(units, "Module network").dependencies).toContain(
      prefix.stableKey,
    );
    expect(named(units, "Output instance_id").dependencies).toContain(
      instance.stableKey,
    );
  });

  it("splits independently meaningful nested-only blocks without duplicating parents", () => {
    const units = analyze(`resource "aws_security_group" "web" {
  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port = ingress.value
      to_port   = ingress.value
    }
  }
}

check "service" {
  assert {
    condition     = module.api.healthy
    error_message = "API is unhealthy"
  }

  assert {
    condition     = data.http.health.status_code == 200
    error_message = "health endpoint failed"
  }
}
`);

    expect(units.map(({ name }) => name)).not.toContain(
      "aws_security_group.web",
    );
    const dynamic = named(units, "aws_security_group.web › Dynamic ingress");
    expect(dynamic.source).toContain('resource "aws_security_group" "web"');
    expect(dynamic.dependencies).toContain("Variable ports");

    expect(units.map(({ name }) => name)).not.toContain("Check service");
    const assertions = units.filter(({ name }) =>
      name.startsWith("Check service › Assertion"),
    );
    expect(assertions).toHaveLength(2);
    expect(assertions.every(({ kind }) => kind === "test")).toBe(true);
    expect(assertions[0]?.source).not.toContain("status_code");
    expect(assertions[1]?.dependencies).toContain("Data http.health");
  });

  it("models Terraform test runs, fixtures, mocks, and assertions", () => {
    const units = analyze(
      `terraform {
  command = plan
}

mock_provider "aws" {
  mock_data "aws_ami" {
    defaults = { id = "ami-test" }
  }
}

variables {
  region = "eu-west-1"
}

run "creates_instance" {
  command = plan

  assert {
    condition     = aws_instance.web.instance_type == "t3.micro"
    error_message = "unexpected instance type"
  }
}

run "exports_identifier" {
  command = apply
  assert {
    condition     = output.instance_id != ""
    error_message = "identifier was empty"
  }
}
`,
      "tests/web.tftest.hcl",
    );

    expect(named(units, "Terraform test configuration").kind).toBe(
      "test_suite",
    );
    expect(named(units, "mock provider aws").kind).toBe("test_hook");
    expect(named(units, "variables").kind).toBe("test_hook");
    expect(named(units, "Run creates_instance").kind).toBe("test");
    expect(named(units, "Run creates_instance").source).toContain("assert");
    expect(named(units, "Run exports_identifier").kind).toBe("test");
  });

  it("splits tfvars inputs and retains interpolated dependencies only", () => {
    const units = analyze(
      `# Deployment inputs
region = "eu-west-1"

banner = <<-EOT
  literal fake { block } and var.not_a_reference
  selected = \${var.region}
EOT

settings = {
  text = "resource \\"fake\\" \\"unit\\" { }"
}
`,
      "environments/production.tfvars",
    );

    const region = named(units, "Input region");
    expect(region.source).toContain("Deployment inputs");
    const banner = named(units, "Input banner");
    expect(banner.dependencies).toContain(region.stableKey);
    expect(banner.dependencies).not.toContain("Variable not_a_reference");
    expect(named(units, "Input settings").source).toContain("resource");
    expect(units.some(({ name }) => name.includes("fake.unit"))).toBe(false);
  });

  it("handles comments, heredocs, interpolation braces, and quoted braces opaquely", () => {
    const content = `# a misleading resource "fake" "comment" { }
resource "null_resource" "example" {
  triggers = {
    quoted = "closing } and opening { and \${local.actual}"
    script = <<SCRIPT
if true; then
  echo "{ not HCL }"
fi
SCRIPT
  }
}

locals {
  actual = "ready"
}
`;
    const units = analyze(content);
    expect(
      units.filter(({ name }) => name === "null_resource.example"),
    ).toHaveLength(1);
    expect(units.some(({ name }) => name.includes("fake"))).toBe(false);
    expect(named(units, "null_resource.example").dependencies).toContain(
      named(units, "Local actual").stableKey,
    );
    expect(hclParserInternals.maskHclSource(content)).toHaveLength(
      content.length,
    );
  });

  it("treats empty and comments-only files as context, but not literal content", () => {
    const context = `# Terraform moved to generated configuration.
// Keep this file for module discovery.
/* No active declarations. */
`;
    expect(isContextOnly(context)).toBe(true);
    expect(
      hclAdapter.analyze({
        path: "infra/empty.tf",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(isContextOnly('"not a comment"')).toBe(false);
    expect(analyze('"not valid but reviewable"')).toHaveLength(1);
  });

  it("creates distinct stable identities for repeated unlabeled operations", () => {
    const units = analyze(`moved {
  from = aws_instance.old
  to   = aws_instance.new
}

moved {
  from = aws_instance.legacy
  to   = aws_instance.current
}

import {
  id = "i-123"
  to = aws_instance.current
}
`);
    const moved = units.filter(({ name }) => name.startsWith("Moved mapping"));
    expect(moved).toHaveLength(2);
    expect(new Set(moved.map(({ stableKey }) => stableKey)).size).toBe(2);
    expect(named(units, "Import mapping 1").kind).toBe("module");
  });
});
