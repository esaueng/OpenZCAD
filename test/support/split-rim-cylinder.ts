import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

export interface SplitRimCylinderOptions {
  radius?: number;
  height?: number;
  axis?: 'x' | 'z';
}

/**
 * A synthetic closed STEP cylinder whose one cylindrical face has a six-edge
 * outer loop: two half-circle edges at each rim and a duplicated seam line.
 * That periodic boundary layout reproduces the imported-face-area regression
 * without embedding any customer geometry.
 */
const splitRimCylinderStep = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('remus STEP export'), '2;1');
FILE_NAME('output.stp', '2024-01-01T00:00:00', (''), (''), 'remus', 'remus', '');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#2 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#3 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#4 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07), #1, 'distance_accuracy_value', 'confusion accuracy');
#5 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#4)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1,#2,#3)) REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY') );
#6 = APPLICATION_CONTEXT('configuration controlled 3D design of mechanical parts and assemblies');
#7 = MECHANICAL_CONTEXT('', #6, 'mechanical');
#8 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'config_control_design', 1994, #6);
#9 = PRODUCT('remus_solid', 'remus_solid', '', (#7));
#10 = PRODUCT_DEFINITION_FORMATION('', '', #9);
#11 = PRODUCT_DEFINITION_CONTEXT('part definition', #6, 'design');
#12 = PRODUCT_DEFINITION('design', '', #10, #11);
#13 = CARTESIAN_POINT('', (0., 0., 0.));
#14 = DIRECTION('', (0., 0., 1.00000000000000000E0));
#15 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#16 = AXIS2_PLACEMENT_3D('', #13, #14, #15);
#17 = CYLINDRICAL_SURFACE('', #16, 5.00000000000000000E0);
#18 = CARTESIAN_POINT('', (0., 0., 0.));
#19 = DIRECTION('', (0., 0., -1.00000000000000000E0));
#20 = DIRECTION('', (0., -1.00000000000000000E0, 0.));
#21 = AXIS2_PLACEMENT_3D('', #18, #19, #20);
#22 = PLANE('', #21);
#23 = CARTESIAN_POINT('', (0., 0., 1.70000000000000000E1));
#24 = DIRECTION('', (0., 0., 1.00000000000000000E0));
#25 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#26 = AXIS2_PLACEMENT_3D('', #23, #24, #25);
#27 = PLANE('', #26);
#28 = CARTESIAN_POINT('', (0., 5.00000000000000000E0, 1.70000000000000000E1));
#29 = VERTEX_POINT('', #28);
#30 = CARTESIAN_POINT('', (0., 5.00000000000000000E0, 0.));
#31 = VERTEX_POINT('', #30);
#32 = CARTESIAN_POINT('', (0., 5.00000000000000000E0, 1.70000000000000000E1));
#33 = DIRECTION('', (0., 0., -1.00000000000000000E0));
#34 = VECTOR('', #33, 1.70000000000000000E1);
#35 = LINE('', #32, #34);
#36 = EDGE_CURVE('', #29, #31, #35, .T.);
#37 = ORIENTED_EDGE('', *, *, #36, .T.);
#38 = CARTESIAN_POINT('', (-6.12323399573676628E-16, -5.00000000000000000E0, 0.));
#39 = VERTEX_POINT('', #38);
#40 = CARTESIAN_POINT('', (0., 0., 0.));
#41 = DIRECTION('', (0., 0., 1.00000000000000000E0));
#42 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#43 = AXIS2_PLACEMENT_3D('', #40, #41, #42);
#44 = CIRCLE('', #43, 5.00000000000000000E0);
#45 = TRIMMED_CURVE('', #44, (PARAMETER_VALUE(0.00000000000000000E0)), (PARAMETER_VALUE(3.14159265358979312E0)), .T., .PARAMETER.);
#46 = EDGE_CURVE('', #31, #39, #45, .T.);
#47 = ORIENTED_EDGE('', *, *, #46, .T.);
#48 = CARTESIAN_POINT('', (0., 0., 0.));
#49 = DIRECTION('', (0., 0., -1.00000000000000000E0));
#50 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#51 = AXIS2_PLACEMENT_3D('', #48, #49, #50);
#52 = CIRCLE('', #51, 5.00000000000000000E0);
#53 = TRIMMED_CURVE('', #52, (PARAMETER_VALUE(0.00000000000000000E0)), (PARAMETER_VALUE(3.14159265358979312E0)), .T., .PARAMETER.);
#54 = EDGE_CURVE('', #31, #39, #53, .T.);
#55 = ORIENTED_EDGE('', *, *, #54, .F.);
#56 = ORIENTED_EDGE('', *, *, #36, .F.);
#57 = CARTESIAN_POINT('', (-6.12323399573676628E-16, -5.00000000000000000E0, 1.70000000000000000E1));
#58 = VERTEX_POINT('', #57);
#59 = CARTESIAN_POINT('', (0., 0., 1.70000000000000000E1));
#60 = DIRECTION('', (0., 0., -1.00000000000000000E0));
#61 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#62 = AXIS2_PLACEMENT_3D('', #59, #60, #61);
#63 = CIRCLE('', #62, 5.00000000000000000E0);
#64 = TRIMMED_CURVE('', #63, (PARAMETER_VALUE(0.00000000000000000E0)), (PARAMETER_VALUE(3.14159265358979312E0)), .T., .PARAMETER.);
#65 = EDGE_CURVE('', #29, #58, #64, .T.);
#66 = ORIENTED_EDGE('', *, *, #65, .T.);
#67 = CARTESIAN_POINT('', (0., 0., 1.70000000000000000E1));
#68 = DIRECTION('', (0., 0., 1.00000000000000000E0));
#69 = DIRECTION('', (0., 1.00000000000000000E0, 0.));
#70 = AXIS2_PLACEMENT_3D('', #67, #68, #69);
#71 = CIRCLE('', #70, 5.00000000000000000E0);
#72 = TRIMMED_CURVE('', #71, (PARAMETER_VALUE(0.00000000000000000E0)), (PARAMETER_VALUE(3.14159265358979312E0)), .T., .PARAMETER.);
#73 = EDGE_CURVE('', #29, #58, #72, .T.);
#74 = ORIENTED_EDGE('', *, *, #73, .F.);
#75 = EDGE_LOOP('', (#37, #47, #55, #56, #66, #74));
#76 = FACE_OUTER_BOUND('', #75, .T.);
#77 = ADVANCED_FACE('', (#76), #17, .T.);
#78 = ORIENTED_EDGE('', *, *, #54, .T.);
#79 = ORIENTED_EDGE('', *, *, #46, .F.);
#80 = EDGE_LOOP('', (#78, #79));
#81 = FACE_OUTER_BOUND('', #80, .T.);
#82 = ADVANCED_FACE('', (#81), #22, .T.);
#83 = ORIENTED_EDGE('', *, *, #73, .T.);
#84 = ORIENTED_EDGE('', *, *, #65, .F.);
#85 = EDGE_LOOP('', (#83, #84));
#86 = FACE_OUTER_BOUND('', #85, .T.);
#87 = ADVANCED_FACE('', (#86), #27, .T.);
#88 = CLOSED_SHELL('', (#77, #82, #87));
#89 = MANIFOLD_SOLID_BREP('', #88);
#90 = ADVANCED_BREP_SHAPE_REPRESENTATION('remus export', (#89), #5);
#91 = PRODUCT_DEFINITION_SHAPE('','',#12);
#92 = SHAPE_DEFINITION_REPRESENTATION(#91, #90);
ENDSEC;
END-ISO-10303-21;
`;

function stepNumber(value: number): string {
  return value.toExponential(17).replace('e', 'E');
}

function rotateStepToX(stepText: string): string {
  return stepText.replace(
    /((?:CARTESIAN_POINT|DIRECTION)\('', \()([^)]*)(\))/g,
    (_match, prefix: string, coordinates: string, suffix: string) => {
      const [x, y, z] = coordinates.split(',').map(Number);
      const clean = (value: number) => (Math.abs(value) < 1e-14 ? 0 : value);
      return `${prefix}${stepNumber(clean(z!))}, ${stepNumber(clean(y!))}, ${stepNumber(clean(-x!))}${suffix}`;
    }
  );
}

export async function splitRimCylinderDocument(
  options: SplitRimCylinderOptions = {}
) {
  const radius = options.radius ?? 5;
  const height = options.height ?? 17;
  if (!Number.isFinite(radius) || radius <= 0)
    throw new RangeError('radius must be positive and finite');
  if (!Number.isFinite(height) || height <= 0)
    throw new RangeError('height must be positive and finite');
  let stepText = splitRimCylinderStep
    .replaceAll('5.00000000000000000E0', stepNumber(radius))
    .replaceAll('1.70000000000000000E1', stepNumber(height));
  if (options.axis === 'x') stepText = rotateStepToX(stepText);
  return importStepBody(
    createProjectDocument('Split-rim cylinder preview', toUserId('user_test')),
    {
      name: 'Split-rim cylinder',
      sourceName: 'split-rim-cylinder.step',
      artifactId: 'artifact_split_rim_cylinder',
      stepText
    }
  );
}
