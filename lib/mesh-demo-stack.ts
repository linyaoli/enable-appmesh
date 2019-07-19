import {CfnMesh, CfnRoute, CfnVirtualNode, CfnVirtualRouter, CfnVirtualService} from "@aws-cdk/aws-appmesh";
import {Port, SecurityGroup, SubnetType, Vpc} from "@aws-cdk/aws-ec2";
import {Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDriver} from "@aws-cdk/aws-ecs";
import {ApplicationLoadBalancer, HealthCheck} from "@aws-cdk/aws-elasticloadbalancingv2";
import {ManagedPolicy, Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import {LogGroup, RetentionDays} from "@aws-cdk/aws-logs";
import {CfnOutput, Construct, Duration, RemovalPolicy, Stack, StackProps} from "@aws-cdk/core";

export class MeshDemoStack extends Stack {

  // gateway and colorteller listen on 8080 by default, just being explicit
  readonly APP_PORT = 8080;

  // want short ttl while testing
  readonly DEF_TTL = Duration.seconds(10);

  // use the same tag for gateway and colorteller images
  readonly IMAGE_TAG = "latest";

  // cloudwatch and xray permissions
  taskRole: Role;

  // ecr pull image permission
  taskExecutionRole: Role;

  vpc: Vpc;
  cluster: Cluster;
  namespace: string = "mesh.local";

  // inbound 8080, 9901, 15000; all outbound
  internalSecurityGroup: SecurityGroup;

  // inbound 80; all outbound
  externalSecurityGroup: SecurityGroup;

  // 'demo' group; one day retention; destroy with stack
  logGroup: LogGroup;

  healthCheck: HealthCheck = {
    "path": "/ping",
    "port": `${this.APP_PORT}`, //"traffic-port",
    "interval": Duration.seconds(30),
    "timeout": Duration.seconds(5),
    "healthyThresholdCount": 2,
    "unhealthyThresholdCount": 2,
    "healthyHttpCodes": "200-499",
  };

  // create colortellers, service names in Cloud Map, and corresponding virtual nodes for these colors
  // the first color is treated as a default color: it's service name will be "colorteller"
  // due to a limitation with the current version of CDK, subsequent color services will be
  // named like "colorteller-green," etc.
  colors = ["blue", "green"];

  mesh: CfnMesh;

  // TODO - this is just a placeholder since current CDK API doesn't support Cloud Map attributes yet
  // Need to know task family when creating virtual nodes that use
  // ECS_TASK_DEFINITION_FAMILY attribute. The attribute allows filtering
  // service name IPs in Cloud Map by task family when ECS registers a new task.
  // App Mesh virtual nodes use this to distinguish which node to route traffic to.
  // All super cool and clever and unfortunately not supported by CDK quite yet!
  taskFamily = new Map<string, string>();

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.createLogGroup();

    this.createVpc();
    this.createCluster();
    this.createGateway();
    this.createColorTeller(...this.colors);
    this.createMesh();
  }

  createLogGroup() {
    this.logGroup = new LogGroup(this, "LogGroup", {
      logGroupName: "demo",
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  createVpc() {
    // The VPC will have 2 AZs, 2 NAT gateways, and an internet gateway
    this.vpc = new Vpc(this, "demoVPC", {
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "ingress",
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "application",
          subnetType: SubnetType.PRIVATE,
        },
      ],
    });

    // Allow inbound web traffic on port 80
    this.externalSecurityGroup = new SecurityGroup(this, "DemoExternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    this.externalSecurityGroup.connections.allowFromAnyIpv4(Port.tcp(80));

    // Allow communication within the vpc for the app and envoy containers
    // - 8080: default app port for gateway and colorteller
    // - 9901: envoy admin interface, used for health check
    // - 15000: envoy ingress ports (egress over 15001 will be allowed by allowAllOutbound)
    this.internalSecurityGroup = new SecurityGroup(this, "DemoInternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    [Port.tcp(this.APP_PORT), Port.tcp(9901), Port.tcp(15000)].forEach(port => {
      this.internalSecurityGroup.connections.allowInternally(port);
    });
  }

  createCluster() {
    // Deploy a Fargate cluster on ECS
    this.cluster = new Cluster(this, "DemoCluster", {
      vpc: this.vpc,
    });

    // Use Cloud Map for service discovery within the cluster, which
    // relies on either ECS Service Discovery or App Mesh integration
    // (default: cloudmap.NamespaceType.DNS_PRIVATE)
    let ns = this.cluster.addDefaultCloudMapNamespace({
      name: this.namespace,
    });
    // we need to ensure the service record is created for after we enable app mesh
    // (there is no resource we create here that will make this happen implicitly
    // since CDK won't all two services to register the same service name in
    // Cloud Map, even though we can discriminate between them using service attributes
    // based on ECS_TASK_DEFINITION_FAMILY
    // let serviceName = new Service(this, "colorteller", {
    //   name: 'colorteller',
    //   namespace: ns,
    //   dnsTtl: this.DEF_TTL,
    // });

    // IAM role for the color app tasks
    this.taskRole = new Role(this, "DemoTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
      ],
    });

    // IAM task execution role for the color app tasks to be able to pull images from ECR
    this.taskExecutionRole = new Role(this, "demoTaskExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
      ],
    });
  }

  createGateway() {
    let gatewayTaskDef = new FargateTaskDefinition(this, "GatewayTaskDef-v2", {
      taskRole: this.taskRole,
      executionRole: this.taskExecutionRole,
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    // stash this for virtual node spec later
    this.taskFamily.set("gateway", gatewayTaskDef.family);

    //repositoryarn: '226767807331.dkr.ecr.us-west-2.amazonaws.com/gateway:latest',
    let gatewayContainer = gatewayTaskDef.addContainer("app", {
      image: ContainerImage.fromRegistry(`subfuzion/colorgateway:${this.IMAGE_TAG}`),
      environment: {
        SERVER_PORT: `${this.APP_PORT}`,
        COLOR_TELLER_ENDPOINT: `colorteller.${this.namespace}:${this.APP_PORT}`,
      },
      logging: LogDriver.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: "gateway",
      }),
    });
    gatewayContainer.addPortMappings({
      containerPort: this.APP_PORT,
    });

    let gatewayService = new FargateService(this, "GatewayService-v2", {
      cluster: this.cluster,
      serviceName: "gateway",
      taskDefinition: gatewayTaskDef,
      desiredCount: 1,
      securityGroup: this.internalSecurityGroup,
      cloudMapOptions: {
        name: "gateway",
      },
    });

    let alb = new ApplicationLoadBalancer(this, "DemoALB", {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.externalSecurityGroup,
    });
    let albListener = alb.addListener("web", {
      port: 80,
    });
    albListener.addTargets("demotarget", {
      port: 80,
      targets: [gatewayService],
      healthCheck: this.healthCheck,
    });
    new CfnOutput(this, "alburl", {
      description: "Color App public URL",
      value: alb.loadBalancerDnsName,
    });
  }

  createColorTeller(...colors: string[]) {
    let create = (color: string, serviceName: string) => {
      let taskDef = new FargateTaskDefinition(this, `${color}_taskdef-v2`, {
        taskRole: this.taskRole,
        executionRole: this.taskExecutionRole,
        cpu: 512,
        memoryLimitMiB: 1024,
      });
      // stash this for virtual node spec later
      this.taskFamily.set(color, taskDef.family);

      let container = taskDef.addContainer("app", {
        image: ContainerImage.fromRegistry(`subfuzion/colorteller:${this.IMAGE_TAG}`),
        environment: {
          SERVER_PORT: `${this.APP_PORT}`,
          COLOR: color,
        },
        logging: LogDriver.awsLogs({
          logGroup: this.logGroup,
          streamPrefix: `colorteller-${color}`,
        }),
      });
      container.addPortMappings({
        containerPort: this.APP_PORT,
      });

      let service = new FargateService(this, `DemoColorTellerService-${color}-v2`, {
        cluster: this.cluster,
        serviceName: serviceName,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroup: this.internalSecurityGroup,
        cloudMapOptions: {
          name: serviceName,
          dnsTtl: this.DEF_TTL,
        },
      });
    };

    // initial color is a special case; before we enable app mesh, gateway
    // needs to reference an actual colorteller.mesh.local service (COLOR_TELLER_ENDPOINT);
    // the other colors need a unique namespace for now because CDK won't
    // allow reusing the same service name (although we can do this without
    // CDK; this is supported by Cloud Map / App Mesh, which uses Cloud
    // Map attributes for ECS service discovery: ECS_TASK_DEFINITION_FAMILY
    create(colors[0], "colorteller");
    colors.forEach(color => {
      create(color.slice(1), `colorteller-${color}`);
    });
  }

  createMesh() {
    this.mesh = new CfnMesh(this, "DemoMesh", {
      meshName: "demomesh",
    });

    this.createVirtualNodes();
    let router = this.createVirtualRouter();
    this.createRoute(router);
    this.createVirtualService(router);
  }

  createVirtualNodes() {
    this.colors.forEach(color => {
      // WARNING: keep name in sync with the route spec, if using this node in a route
      // WARNING: keep name in sync with the virtual service, if using this node as a provider
      // update the route spec as well in createRoute()
      let name = `${color}-vn`;
      new CfnVirtualNode(this, `Demo-${name}`, {
        meshName: this.mesh.meshName,
        virtualNodeName: name,
        spec: {
          listeners: [{
            portMapping: {
              protocol: "http",
              port: this.APP_PORT,
            },
          }],
          serviceDiscovery: {
            dns: {
              // special case for the default color
              hostname: name.startsWith(this.colors[0]) ? "colorteller" : name,
            },
          },
        },
      }).addDependsOn(this.mesh);
    });
  }

  createVirtualRouter(): CfnVirtualRouter {
    let router = new CfnVirtualRouter(this, "DemoColorTellerVirtualRouter", {
      // WARNING: keep in sync with virtual service provider if using this
      virtualRouterName: "colorteller-vr",
      meshName: this.mesh.meshName,
      spec: {
        listeners: [{
          portMapping: {
            protocol: "http",
            port: this.APP_PORT,
          },
        }],
      },
    });
    router.addDependsOn(this.mesh);
    return router;
  }

  createRoute(router: CfnVirtualRouter) {
    let route = new CfnRoute(this, "DemoColorTellerRoute", {
      routeName: "colorteller-route",
      meshName: this.mesh.meshName,
      virtualRouterName: router.virtualRouterName,
      spec: {
        httpRoute: {
          match: {
            prefix: "/",
          },
          action: {
            weightedTargets: [{
              // WARNING: if you change the name for a virtual node, make sure you update this also
              virtualNode: "blue-vn",
              weight: 1,
            }],
          },
        },
      },
    });
    route.addDependsOn(router);
  }

  createVirtualService(router: CfnVirtualRouter) {
    let svc = new CfnVirtualService(this, "ColorTellerVirtualService", {
      virtualServiceName: `colorteller.${this.namespace}`,
      meshName: this.mesh.meshName,
      spec: {
        provider: {
          // WARNING: keep in sync with virtual node name if using that as this provider
          // WARNING: keep in sync with virtual router name if using that as this provider
          virtualRouter: {virtualRouterName: "colorteller-vr"},
        },
      },
    });
    svc.addDependsOn(router);
  }

}
