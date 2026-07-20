# Wrap Daytona as a Backend External Seam

MakeADemo will provision and operate Daytona workspaces through a backend External Seam used by Repo Preparation, Script Generation, Capture Path Validation, and repair attempts, rather than treating Daytona setup as manual ops bootstrap outside the product. We chose this because agentic preparation and script repair depend on workspace lifecycle, command execution and logs, network settings, and teardown, and those behaviors need a small testable interface with fakes for pipeline tests.

The seam should hide Daytona-specific SDK or API calls from pipeline orchestration. Repo Preparation should depend on product-level workspace operations such as create, execute, stream logs, update network policy, and destroy.

Agent Harness runs backed by Daytona should still produce the existing Preparation Manifest, Demo Script, validation evidence, and workspace diff artifact. Daytona is the execution substrate, not a replacement for pipeline output contracts.

MakeADemo should persist only bounded provider-neutral lifecycle metadata from each run: stage, provider/model identifiers, output lengths, activity kinds, tool names, and timestamps. Assistant text, user prompts, tool arguments and results, secrets, and raw diagnostic contents must not be persisted. Pipeline artifacts such as validation evidence, network-policy events, the final diff, and the Preparation Manifest remain separate product contracts and are not agent transcripts.

The backend seam should enforce bounded timeouts for post-provisioning agent work, including dependency installation, demo build, manifest generation, script generation, and repair attempts. If a timeout fires, MakeADemo should close outbound network access and tear down the Daytona workspace as part of cleanup.
