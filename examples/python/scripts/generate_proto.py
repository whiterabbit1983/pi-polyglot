"""Generate bindings from the shared contract; only writes inside this example."""
from pathlib import Path
import subprocess
import sys

example = Path(__file__).resolve().parents[1]
proto = example.parents[1] / "proto"
out = example / "polyglot_example" / "generated"
out.mkdir(parents=True, exist_ok=True)
subprocess.run([
    sys.executable, "-m", "grpc_tools.protoc", f"-I{proto}",
    f"--python_out={out}", f"--grpc_python_out={out}", str(proto / "extension.proto"),
], check=True)
(out / "__init__.py").write_text('"""Generated protocol bindings; see scripts/generate_proto.py."""\n')
module = out / "extension_pb2_grpc.py"
module.write_text(module.read_text().replace(
    "import extension_pb2 as extension__pb2", "from . import extension_pb2 as extension__pb2"))
